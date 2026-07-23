import { InvalidDanmakuConfigurationError, InvalidDanmakuMessageError } from './errors.js';
export const DEFAULT_DANMAKU_LIMITS = {
    maxPending: 200,
    maxVisible: 80,
    maxPoolSize: 96,
    maxTextLength: 500,
    maxBadgesPerMessage: 4,
    maxMountsPerFrame: 8,
    maxMetadataKeys: 16,
    maxMetadataDepth: 2,
    maxMetadataBytes: 2_048,
    maxIntakePerSecond: 120,
    maxDisplayPerSecond: 60,
};
export const DEFAULT_DANMAKU_POLICY = {
    laneHeight: 32,
    laneGap: 12,
    scrollPixelsPerSecond: 140,
    fixedDurationMs: 4_000,
    maxPendingAgeMs: 8_000,
    maxLaneWaitMs: 2_000,
    duplicateWindowMs: 500,
    frameBudgetMs: 8,
};
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 80;
const MAX_IDENTITY_KIND_LENGTH = 40;
const MAX_IDENTITY_LABEL_LENGTH = 80;
const MAX_VARIANT_LENGTH = 40;
const MAX_ASSET_KEY_LENGTH = 160;
export function resolveLimits(input) {
    const limits = {
        ...DEFAULT_DANMAKU_LIMITS,
        ...input,
    };
    validatePositiveIntegerRecord(limits);
    if (limits.maxPoolSize < limits.maxVisible) {
        throw new InvalidDanmakuConfigurationError('limits.maxPoolSize');
    }
    return limits;
}
export function resolvePolicy(input) {
    const policy = {
        ...DEFAULT_DANMAKU_POLICY,
        ...input,
    };
    for (const [key, value] of Object.entries(policy)) {
        if (!Number.isFinite(value) || value <= 0) {
            throw new InvalidDanmakuConfigurationError(`policy.${key}`);
        }
    }
    return policy;
}
export function validateViewport(viewport) {
    if (!Number.isFinite(viewport.width) || viewport.width <= 0) {
        throw new InvalidDanmakuConfigurationError('viewport.width');
    }
    if (!Number.isFinite(viewport.height) || viewport.height <= 0) {
        throw new InvalidDanmakuConfigurationError('viewport.height');
    }
}
export function sanitizeMessage(input, limits) {
    validateRequiredMessageFields(input);
    const identitiesResult = sanitizeIdentities(input.identities, limits.maxBadgesPerMessage);
    const metadataResult = sanitizeMetadata(input.metadata, limits);
    const color = sanitizeColor(input.color);
    const sender = sanitizeSender(input);
    const message = {
        id: input.id,
        receivedAt: input.receivedAt,
        text: input.text,
        mode: input.mode,
        priority: input.priority,
        ...(color === undefined ? {} : { color }),
        ...(sender === undefined ? {} : { sender }),
        ...(identitiesResult.identities === undefined
            ? {}
            : { identities: identitiesResult.identities }),
        ...(metadataResult.metadata === undefined ? {} : { metadata: metadataResult.metadata }),
    };
    return {
        message,
        metadataDiscarded: metadataResult.discarded,
        identitiesTruncated: identitiesResult.truncated,
        colorDiscarded: input.color !== undefined && color === undefined,
    };
}
export function emitSanitizationDiagnostics(sanitized, emit) {
    if (sanitized.metadataDiscarded) {
        emit({
            scope: 'danmaku',
            code: 'metadata-discarded',
            level: 'warn',
            detail: { messageId: sanitized.message.id },
        });
    }
    if (sanitized.identitiesTruncated) {
        emit({
            scope: 'danmaku',
            code: 'identities-truncated',
            level: 'warn',
            detail: { messageId: sanitized.message.id },
        });
    }
    if (sanitized.colorDiscarded) {
        emit({
            scope: 'danmaku',
            code: 'color-discarded',
            level: 'warn',
            detail: { messageId: sanitized.message.id },
        });
    }
}
function validatePositiveIntegerRecord(limits) {
    for (const [key, value] of Object.entries(limits)) {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new InvalidDanmakuConfigurationError(`limits.${key}`);
        }
    }
}
function validateRequiredMessageFields(input) {
    if (typeof input !== 'object' || input === null) {
        throw new InvalidDanmakuMessageError('message');
    }
    validateBoundedString(input.id, 'id', MAX_ID_LENGTH, false);
    if (!Number.isFinite(input.receivedAt) || input.receivedAt < 0) {
        throw new InvalidDanmakuMessageError('receivedAt');
    }
    if (typeof input.text !== 'string' || input.text.length === 0) {
        throw new InvalidDanmakuMessageError('text');
    }
    if (input.mode !== 'scroll' && input.mode !== 'top' && input.mode !== 'bottom') {
        throw new InvalidDanmakuMessageError('mode');
    }
    if (!Number.isSafeInteger(input.priority)) {
        throw new InvalidDanmakuMessageError('priority');
    }
}
function sanitizeSender(input) {
    if (input.sender === undefined) {
        return undefined;
    }
    const unknownSender = input.sender;
    if (!isPlainRecord(unknownSender)) {
        throw new InvalidDanmakuMessageError('sender');
    }
    const displayName = unknownSender.displayName;
    if (displayName === undefined) {
        return {};
    }
    validateUnknownBoundedString(displayName, 'sender.displayName', MAX_NAME_LENGTH, true);
    if (typeof displayName !== 'string') {
        throw new InvalidDanmakuMessageError('sender.displayName');
    }
    return { displayName };
}
function sanitizeIdentities(input, limit) {
    if (input === undefined) {
        return { truncated: false };
    }
    const unknownInput = input;
    if (!Array.isArray(unknownInput)) {
        throw new InvalidDanmakuMessageError('identities');
    }
    const identities = [];
    const retained = unknownInput.slice(0, limit);
    for (const identity of retained) {
        if (!isPlainRecord(identity)) {
            throw new InvalidDanmakuMessageError('identities');
        }
        const kind = identity.kind;
        const label = identity.label;
        const level = identity.level;
        const variant = identity.variant;
        const assetKey = identity.assetKey;
        validateUnknownBoundedString(kind, 'identities.kind', MAX_IDENTITY_KIND_LENGTH, false);
        validateUnknownBoundedString(label, 'identities.label', MAX_IDENTITY_LABEL_LENGTH, true);
        if (level !== undefined &&
            (typeof level !== 'number' || !Number.isSafeInteger(level) || level < 0)) {
            throw new InvalidDanmakuMessageError('identities.level');
        }
        if (variant !== undefined) {
            validateUnknownBoundedString(variant, 'identities.variant', MAX_VARIANT_LENGTH, false);
        }
        if (assetKey !== undefined) {
            validateUnknownBoundedString(assetKey, 'identities.assetKey', MAX_ASSET_KEY_LENGTH, false);
        }
        if (typeof kind !== 'string' || typeof label !== 'string') {
            throw new InvalidDanmakuMessageError('identities');
        }
        identities.push({
            kind,
            label,
            ...(typeof level === 'number' ? { level } : {}),
            ...(typeof variant === 'string' ? { variant } : {}),
            ...(typeof assetKey === 'string' ? { assetKey } : {}),
        });
    }
    return {
        identities,
        truncated: unknownInput.length > limit,
    };
}
function sanitizeMetadata(input, limits) {
    if (input === undefined) {
        return { discarded: false };
    }
    try {
        const budget = { keys: 0 };
        const sanitized = copyMetadataValue(input, 0, budget, limits);
        if (!isPlainRecord(sanitized)) {
            return { discarded: true };
        }
        const serialized = JSON.stringify(sanitized);
        if (new TextEncoder().encode(serialized).byteLength > limits.maxMetadataBytes) {
            return { discarded: true };
        }
        return { metadata: sanitized, discarded: false };
    }
    catch {
        return { discarded: true };
    }
}
function copyMetadataValue(value, depth, budget, limits) {
    if (value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))) {
        return value;
    }
    if (depth >= limits.maxMetadataDepth) {
        throw new Error('metadata depth');
    }
    if (Array.isArray(value)) {
        const result = [];
        for (const item of value) {
            budget.keys += 1;
            if (budget.keys > limits.maxMetadataKeys) {
                throw new Error('metadata keys');
            }
            result.push(copyMetadataValue(item, depth + 1, budget, limits));
        }
        return result;
    }
    if (!isPlainRecord(value)) {
        throw new Error('metadata value');
    }
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
        budget.keys += 1;
        if (budget.keys > limits.maxMetadataKeys) {
            throw new Error('metadata keys');
        }
        result[key] = copyMetadataValue(nested, depth + 1, budget, limits);
    }
    return result;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isPlainRecord(value) {
    if (!isRecord(value)) {
        return false;
    }
    const prototype = Reflect.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function sanitizeColor(color) {
    if (color === undefined) {
        return undefined;
    }
    if (typeof color !== 'string') {
        throw new InvalidDanmakuMessageError('color');
    }
    const shortMatch = /^#([\da-f]{3})$/i.exec(color);
    if (shortMatch !== null) {
        const digits = shortMatch[1];
        if (digits === undefined) {
            return undefined;
        }
        return `#${digits[0]}${digits[0]}${digits[1]}${digits[1]}${digits[2]}${digits[2]}`.toLowerCase();
    }
    if (/^#[\da-f]{6}$/i.test(color)) {
        return color.toLowerCase();
    }
    return undefined;
}
function validateBoundedString(value, field, maxLength, allowEmpty) {
    if (typeof value !== 'string' ||
        (!allowEmpty && value.length === 0) ||
        value.length > maxLength) {
        throw new InvalidDanmakuMessageError(field);
    }
}
function validateUnknownBoundedString(value, field, maxLength, allowEmpty) {
    if (typeof value !== 'string') {
        throw new InvalidDanmakuMessageError(field);
    }
    validateBoundedString(value, field, maxLength, allowEmpty);
}
