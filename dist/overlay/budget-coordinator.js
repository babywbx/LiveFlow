import { InvalidOverlayConfigurationError, OverlayCapacityError, OverlayDestroyedError, } from './errors.js';
import { mergeInstanceState, validateBudgetLimits, validateInstanceId, validateInstanceState, } from './validation.js';
const MAX_GRANT_LISTENERS = 8;
export function createOverlayBudgetCoordinator(limits) {
    validateBudgetLimits(limits);
    return new BudgetCoordinator(limits);
}
class BudgetCoordinator {
    limits;
    instances = new Map();
    grants = new Map();
    counters = {
        requests: 0,
        fullGranted: 0,
        compactGranted: 0,
        suppressed: 0,
        promoted: 0,
        downgraded: 0,
        released: 0,
    };
    nextGrantId = 1;
    destroyed = false;
    constructor(limits) {
        this.limits = limits;
    }
    register(registration) {
        this.ensureAlive('budget-coordinator');
        validateInstanceId(registration.instanceId);
        validateInstanceState(registration);
        if (this.instances.has(registration.instanceId)) {
            throw new InvalidOverlayConfigurationError('duplicateInstanceId');
        }
        if (this.instances.size >= this.limits.maxInstances) {
            throw new OverlayCapacityError('registered-instances', this.limits.maxInstances);
        }
        const instanceId = registration.instanceId;
        this.instances.set(instanceId, {
            state: {
                weight: registration.weight,
                focused: registration.focused,
                visible: registration.visible,
            },
            grantIds: new Set(),
        });
        let registrationDestroyed = false;
        return {
            update: (state) => {
                if (registrationDestroyed) {
                    throw new OverlayDestroyedError('budget-registration');
                }
                this.ensureAlive('budget-coordinator');
                const record = this.instances.get(instanceId);
                if (record === undefined) {
                    throw new OverlayDestroyedError('budget-registration');
                }
                record.state = mergeInstanceState(record.state, state);
                this.rebalance();
            },
            destroy: () => {
                if (registrationDestroyed) {
                    return;
                }
                registrationDestroyed = true;
                this.removeInstance(instanceId);
            },
        };
    }
    request(instanceId, request) {
        this.ensureAlive('budget-coordinator');
        const instance = this.instances.get(instanceId);
        if (instance === undefined) {
            throw new InvalidOverlayConfigurationError('unregisteredInstanceId');
        }
        if (!Number.isFinite(request.priority)) {
            throw new InvalidOverlayConfigurationError('priority');
        }
        if (typeof request.highCost !== 'boolean') {
            throw new InvalidOverlayConfigurationError('highCost');
        }
        this.counters.requests += 1;
        if (!instance.state.visible || this.grants.size >= this.limits.maxActiveCards) {
            this.counters.suppressed += 1;
            return new SuppressedBudgetGrant();
        }
        const grantId = this.nextGrantId;
        this.nextGrantId += 1;
        const grant = new ActiveBudgetGrant(grantId, instanceId, request, (releasedId) => {
            this.releaseGrant(releasedId);
        });
        this.grants.set(grantId, grant);
        instance.grantIds.add(grantId);
        this.rebalance(grantId);
        if (grant.presentation === 'full') {
            this.counters.fullGranted += 1;
        }
        else {
            this.counters.compactGranted += 1;
        }
        return grant;
    }
    getMetrics() {
        let activeFull = 0;
        let activeHighCost = 0;
        for (const grant of this.grants.values()) {
            if (grant.presentation === 'full') {
                activeFull += 1;
                if (grant.request.highCost) {
                    activeHighCost += 1;
                }
            }
        }
        return {
            ...this.counters,
            registeredInstances: this.instances.size,
            activeCards: this.grants.size,
            activeFull,
            activeHighCost,
        };
    }
    destroy() {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        for (const grant of [...this.grants.values()]) {
            grant.revoke();
            this.counters.released += 1;
        }
        this.grants.clear();
        this.instances.clear();
    }
    removeInstance(instanceId) {
        const instance = this.instances.get(instanceId);
        if (instance === undefined) {
            return;
        }
        this.instances.delete(instanceId);
        for (const grantId of [...instance.grantIds]) {
            const grant = this.grants.get(grantId);
            if (grant !== undefined) {
                this.grants.delete(grantId);
                grant.revoke();
                this.counters.released += 1;
            }
        }
        this.rebalance();
    }
    releaseGrant(grantId) {
        const grant = this.grants.get(grantId);
        if (grant === undefined) {
            return;
        }
        this.grants.delete(grantId);
        const instance = this.instances.get(grant.instanceId);
        instance?.grantIds.delete(grantId);
        grant.revoke();
        this.counters.released += 1;
        this.rebalance();
    }
    rebalance(newGrantId) {
        for (const grant of [...this.grants.values()]) {
            const instance = this.instances.get(grant.instanceId);
            if (instance === undefined || !instance.state.visible) {
                this.grants.delete(grant.id);
                instance?.grantIds.delete(grant.id);
                grant.revoke();
                this.counters.released += 1;
            }
        }
        const ranked = [...this.grants.values()].sort((left, right) => {
            const leftState = this.instances.get(left.instanceId)?.state;
            const rightState = this.instances.get(right.instanceId)?.state;
            if (leftState === undefined || rightState === undefined) {
                return left.id - right.id;
            }
            if (leftState.focused !== rightState.focused) {
                return leftState.focused ? -1 : 1;
            }
            if (leftState.weight !== rightState.weight) {
                return leftState.weight < rightState.weight ? 1 : -1;
            }
            if (left.request.priority !== right.request.priority) {
                return left.request.priority < right.request.priority ? 1 : -1;
            }
            return left.id - right.id;
        });
        let fullCards = 0;
        let highCostAnimations = 0;
        for (const grant of ranked) {
            const canUseFullSlot = fullCards < this.limits.maxFullCards;
            const canUseHighCostSlot = !grant.request.highCost || highCostAnimations < this.limits.maxHighCostAnimations;
            if (canUseFullSlot && canUseHighCostSlot) {
                fullCards += 1;
                if (grant.request.highCost) {
                    highCostAnimations += 1;
                }
                this.setPresentation(grant, 'full', newGrantId);
            }
            else {
                this.setPresentation(grant, 'compact', newGrantId);
            }
        }
    }
    setPresentation(grant, presentation, newGrantId) {
        const previous = grant.presentation;
        grant.setPresentation(presentation);
        if (grant.id === newGrantId || previous === presentation) {
            return;
        }
        if (previous === 'full' && presentation === 'compact') {
            this.counters.downgraded += 1;
        }
        if (previous === 'compact' && presentation === 'full') {
            this.counters.promoted += 1;
        }
    }
    ensureAlive(resource) {
        if (this.destroyed) {
            throw new OverlayDestroyedError(resource);
        }
    }
}
class ActiveBudgetGrant {
    id;
    instanceId;
    request;
    release;
    currentPresentation = 'compact';
    listeners = new Set();
    active = true;
    constructor(id, instanceId, request, release) {
        this.id = id;
        this.instanceId = instanceId;
        this.request = request;
        this.release = release;
    }
    get presentation() {
        return this.currentPresentation;
    }
    subscribe(listener) {
        if (!this.active) {
            notifyListener(listener, 'suppressed');
            return () => { };
        }
        if (this.listeners.size >= MAX_GRANT_LISTENERS) {
            throw new OverlayCapacityError('grant-listeners', MAX_GRANT_LISTENERS);
        }
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    destroy() {
        if (!this.active) {
            return;
        }
        this.release(this.id);
    }
    setPresentation(presentation) {
        if (!this.active || presentation === this.currentPresentation) {
            return;
        }
        this.currentPresentation = presentation;
        this.notify();
    }
    revoke() {
        if (!this.active) {
            return;
        }
        this.active = false;
        this.currentPresentation = 'suppressed';
        this.notify();
        this.listeners.clear();
    }
    notify() {
        for (const listener of [...this.listeners]) {
            notifyListener(listener, this.currentPresentation);
        }
    }
}
class SuppressedBudgetGrant {
    presentation = 'suppressed';
    subscribe(listener) {
        notifyListener(listener, this.presentation);
        return () => { };
    }
    destroy() { }
}
function notifyListener(listener, presentation) {
    try {
        listener(presentation);
    }
    catch {
        return;
    }
}
