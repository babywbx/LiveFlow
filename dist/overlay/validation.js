import { InvalidOverlayConfigurationError, InvalidOverlayEventError } from './errors.js';
export const DEFAULT_OVERLAY_LIMITS = {
    maxPending: 32,
    maxVisible: 1,
    maxNodesPerEvent: 8,
    maxTextLength: 512,
    maxLabelLength: 64,
    maxKeyLength: 128,
    maxRenderers: 32,
    maxDedupeEntries: 128,
    dedupeWindowMs: 15_000,
    maxEventLifetimeMs: 30_000,
};
export const DEFAULT_OVERLAY_INSTANCE_STATE = {
    weight: 1,
    focused: false,
    visible: true,
};
export function resolveOverlayLimits(overrides) {
    const limits = {
        ...DEFAULT_OVERLAY_LIMITS,
        ...overrides,
    };
    validatePositiveInteger('maxPending', limits.maxPending);
    validatePositiveInteger('maxVisible', limits.maxVisible);
    validatePositiveInteger('maxNodesPerEvent', limits.maxNodesPerEvent);
    validatePositiveInteger('maxTextLength', limits.maxTextLength);
    validatePositiveInteger('maxLabelLength', limits.maxLabelLength);
    validatePositiveInteger('maxKeyLength', limits.maxKeyLength);
    validatePositiveInteger('maxRenderers', limits.maxRenderers);
    validatePositiveInteger('maxDedupeEntries', limits.maxDedupeEntries);
    validatePositiveFinite('dedupeWindowMs', limits.dedupeWindowMs);
    validatePositiveFinite('maxEventLifetimeMs', limits.maxEventLifetimeMs);
    return limits;
}
export function validateBudgetLimits(limits) {
    validatePositiveInteger('maxInstances', limits.maxInstances);
    validatePositiveInteger('maxActiveCards', limits.maxActiveCards);
    validatePositiveInteger('maxFullCards', limits.maxFullCards);
    validatePositiveInteger('maxHighCostAnimations', limits.maxHighCostAnimations);
    if (limits.maxFullCards > limits.maxActiveCards) {
        throw new InvalidOverlayConfigurationError('maxFullCards');
    }
    if (limits.maxHighCostAnimations > limits.maxActiveCards) {
        throw new InvalidOverlayConfigurationError('maxHighCostAnimations');
    }
}
export function validateInstanceId(instanceId, maxLength = 128) {
    validateBoundedText(instanceId, 'instanceId', maxLength, InvalidOverlayConfigurationError);
}
export function validateInstanceState(state) {
    if (!Number.isFinite(state.weight) || state.weight <= 0) {
        throw new InvalidOverlayConfigurationError('weight');
    }
    if (typeof state.focused !== 'boolean') {
        throw new InvalidOverlayConfigurationError('focused');
    }
    if (typeof state.visible !== 'boolean') {
        throw new InvalidOverlayConfigurationError('visible');
    }
}
export function mergeInstanceState(state, update) {
    const merged = {
        weight: update.weight ?? state.weight,
        focused: update.focused ?? state.focused,
        visible: update.visible ?? state.visible,
    };
    validateInstanceState(merged);
    return merged;
}
export function validateRendererKind(kind, maxLength) {
    validateBoundedText(kind, 'kind', maxLength, InvalidOverlayConfigurationError);
}
export function parseOverlayEvent(candidate, limits, now) {
    if (!isRecord(candidate)) {
        throw new InvalidOverlayEventError('event');
    }
    const id = boundedEventText(candidate, 'id', limits.maxKeyLength);
    const kind = boundedEventText(candidate, 'kind', limits.maxKeyLength);
    const receivedAt = finiteNumber(candidate, 'receivedAt');
    if (receivedAt < 0 || receivedAt > now) {
        throw new InvalidOverlayEventError('receivedAt');
    }
    const priority = finiteNumber(candidate, 'priority');
    const durationMs = finiteNumber(candidate, 'durationMs');
    if (durationMs <= 0 || durationMs > limits.maxEventLifetimeMs) {
        throw new InvalidOverlayEventError('durationMs');
    }
    const rawNodes = Reflect.get(candidate, 'nodes');
    if (!Array.isArray(rawNodes) ||
        rawNodes.length === 0 ||
        rawNodes.length > limits.maxNodesPerEvent) {
        throw new InvalidOverlayEventError('nodes');
    }
    const nodes = rawNodes.map((node, index) => parseNode(node, index, limits));
    const dedupeCandidate = Reflect.get(candidate, 'dedupeKey');
    if (dedupeCandidate === undefined) {
        return { id, kind, receivedAt, priority, durationMs, nodes };
    }
    if (typeof dedupeCandidate !== 'string') {
        throw new InvalidOverlayEventError('dedupeKey');
    }
    validateEventText(dedupeCandidate, 'dedupeKey', limits.maxKeyLength);
    return { id, dedupeKey: dedupeCandidate, kind, receivedAt, priority, durationMs, nodes };
}
function parseNode(candidate, index, limits) {
    if (!isRecord(candidate)) {
        throw new InvalidOverlayEventError(`nodes.${String(index)}`);
    }
    const type = Reflect.get(candidate, 'type');
    if (type === 'text') {
        return {
            type,
            role: boundedEventText(candidate, 'role', limits.maxKeyLength),
            text: boundedEventText(candidate, 'text', limits.maxTextLength),
        };
    }
    if (type === 'asset') {
        return {
            type,
            role: boundedEventText(candidate, 'role', limits.maxKeyLength),
            assetKey: boundedEventText(candidate, 'assetKey', limits.maxKeyLength),
            alt: boundedEventText(candidate, 'alt', limits.maxLabelLength),
        };
    }
    if (type === 'metric') {
        return {
            type,
            role: boundedEventText(candidate, 'role', limits.maxKeyLength),
            label: boundedEventText(candidate, 'label', limits.maxLabelLength),
            value: boundedEventText(candidate, 'value', limits.maxLabelLength),
        };
    }
    if (type === 'identity') {
        return {
            type,
            identity: parseIdentity(Reflect.get(candidate, 'identity'), index, limits),
        };
    }
    throw new InvalidOverlayEventError(`nodes.${String(index)}.type`);
}
function parseIdentity(candidate, index, limits) {
    if (!isRecord(candidate)) {
        throw new InvalidOverlayEventError(`nodes.${String(index)}.identity`);
    }
    const kind = boundedEventText(candidate, 'kind', limits.maxKeyLength);
    const label = boundedEventText(candidate, 'label', limits.maxLabelLength);
    const levelCandidate = Reflect.get(candidate, 'level');
    const variantCandidate = Reflect.get(candidate, 'variant');
    const assetKeyCandidate = Reflect.get(candidate, 'assetKey');
    if (levelCandidate !== undefined &&
        (typeof levelCandidate !== 'number' ||
            !Number.isSafeInteger(levelCandidate) ||
            levelCandidate < 0)) {
        throw new InvalidOverlayEventError(`nodes.${String(index)}.identity.level`);
    }
    if (variantCandidate !== undefined && typeof variantCandidate !== 'string') {
        throw new InvalidOverlayEventError(`nodes.${String(index)}.identity.variant`);
    }
    if (assetKeyCandidate !== undefined && typeof assetKeyCandidate !== 'string') {
        throw new InvalidOverlayEventError(`nodes.${String(index)}.identity.assetKey`);
    }
    const identity = { kind, label };
    if (levelCandidate !== undefined) {
        identity.level = levelCandidate;
    }
    if (variantCandidate !== undefined) {
        validateEventText(variantCandidate, `nodes.${String(index)}.identity.variant`, limits.maxKeyLength);
        identity.variant = variantCandidate;
    }
    if (assetKeyCandidate !== undefined) {
        validateEventText(assetKeyCandidate, `nodes.${String(index)}.identity.assetKey`, limits.maxKeyLength);
        identity.assetKey = assetKeyCandidate;
    }
    return identity;
}
function boundedEventText(record, field, maxLength) {
    const value = Reflect.get(record, field);
    if (typeof value !== 'string') {
        throw new InvalidOverlayEventError(field);
    }
    validateEventText(value, field, maxLength);
    return value;
}
function validateEventText(value, field, maxLength) {
    validateBoundedText(value, field, maxLength, InvalidOverlayEventError);
}
function finiteNumber(record, field) {
    const value = Reflect.get(record, field);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new InvalidOverlayEventError(field);
    }
    return value;
}
function validatePositiveInteger(field, value) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new InvalidOverlayConfigurationError(field);
    }
}
function validatePositiveFinite(field, value) {
    if (!Number.isFinite(value) || value <= 0) {
        throw new InvalidOverlayConfigurationError(field);
    }
}
function validateBoundedText(value, field, maxLength, ErrorConstructor) {
    if (value.length === 0 || value.length > maxLength) {
        throw new ErrorConstructor(field);
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
