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
    scrollOverlapStartRatio: 0,
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
    const { scrollDurationMs, scrollDurationJitterMs, scrollOverlapStartRatio, ...positivePolicy } = policy;
    if (scrollDurationMs !== undefined &&
        scrollDurationMs !== null &&
        (!Number.isFinite(scrollDurationMs) || scrollDurationMs < 1)) {
        throw new InvalidDanmakuConfigurationError('policy.scrollDurationMs');
    }
    if (scrollDurationJitterMs !== undefined &&
        scrollDurationJitterMs !== null &&
        (!Number.isFinite(scrollDurationJitterMs) || scrollDurationJitterMs < 0)) {
        throw new InvalidDanmakuConfigurationError('policy.scrollDurationJitterMs');
    }
    if (!Number.isFinite(scrollOverlapStartRatio) ||
        scrollOverlapStartRatio < 0 ||
        scrollOverlapStartRatio > 1) {
        throw new InvalidDanmakuConfigurationError('policy.scrollOverlapStartRatio');
    }
    if (scrollDurationMs !== undefined &&
        scrollDurationMs !== null &&
        scrollDurationJitterMs !== undefined &&
        scrollDurationJitterMs !== null &&
        !Number.isFinite(scrollDurationMs + scrollDurationJitterMs)) {
        throw new InvalidDanmakuConfigurationError('policy.scrollDurationJitterMs');
    }
    for (const [key, value] of Object.entries(positivePolicy)) {
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
export function sanitizeMessage(input, required, limits) {
    const identitiesResult = sanitizeIdentities(readMessageField(input, 'identities'), limits.maxBadgesPerMessage);
    const metadataResult = sanitizeMessageMetadata(input, limits);
    const colorInput = readMessageField(input, 'color');
    const color = sanitizeColor(colorInput);
    const sender = sanitizeSender(readMessageField(input, 'sender'));
    const message = {
        ...required,
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
        colorDiscarded: colorInput !== undefined && color === undefined,
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
export function validateRequiredMessageFields(input) {
    if (typeof input !== 'object' || input === null) {
        throw new InvalidDanmakuMessageError('message');
    }
    const id = readMessageField(input, 'id');
    const receivedAt = readMessageField(input, 'receivedAt');
    const text = readMessageField(input, 'text');
    const mode = readMessageField(input, 'mode');
    const priority = readMessageField(input, 'priority');
    if (typeof id !== 'string') {
        throw new InvalidDanmakuMessageError('id');
    }
    validateBoundedString(id, 'id', MAX_ID_LENGTH, false);
    if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt) || receivedAt < 0) {
        throw new InvalidDanmakuMessageError('receivedAt');
    }
    if (typeof text !== 'string' || text.length === 0) {
        throw new InvalidDanmakuMessageError('text');
    }
    if (mode !== 'scroll' && mode !== 'top' && mode !== 'bottom') {
        throw new InvalidDanmakuMessageError('mode');
    }
    if (typeof priority !== 'number' || !Number.isSafeInteger(priority)) {
        throw new InvalidDanmakuMessageError('priority');
    }
    return { id, receivedAt, text, mode, priority };
}
function sanitizeSender(input) {
    if (input === undefined) {
        return undefined;
    }
    if (!isPlainRecord(input)) {
        throw new InvalidDanmakuMessageError('sender');
    }
    const displayName = input.displayName;
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
    if (!Array.isArray(input)) {
        throw new InvalidDanmakuMessageError('identities');
    }
    const identities = [];
    const identityCount = input.length;
    if (!Number.isSafeInteger(identityCount) || identityCount < 0) {
        throw new InvalidDanmakuMessageError('identities');
    }
    const retainedCount = Math.min(identityCount, limit);
    for (let index = 0; index < retainedCount; index += 1) {
        const identity = input[index];
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
        truncated: identityCount > limit,
    };
}
function sanitizeMetadata(input, limits) {
    if (input === undefined) {
        return { discarded: false };
    }
    try {
        const budget = { keys: 0, bytes: 0, encoder: new TextEncoder() };
        const sanitized = copyMetadataObject(input, 0, budget, limits);
        return { metadata: sanitized, discarded: false };
    }
    catch {
        return { discarded: true };
    }
}
function sanitizeMessageMetadata(input, limits) {
    try {
        return sanitizeMetadata(readMessageField(input, 'metadata'), limits);
    }
    catch {
        return { discarded: true };
    }
}
function copyMetadataValue(value, depth, budget, limits) {
    if (value === null) {
        consumeMetadataBytes(4, budget, limits);
        return value;
    }
    if (typeof value === 'string') {
        consumeMetadataString(value, budget, limits);
        return value;
    }
    if (typeof value === 'boolean') {
        consumeMetadataBytes(value ? 4 : 5, budget, limits);
        return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        consumeMetadataBytes(String(value).length, budget, limits);
        return value;
    }
    if (depth >= limits.maxMetadataDepth) {
        throw new Error('metadata depth');
    }
    if (Array.isArray(value)) {
        const items = value;
        const itemCount = items.length;
        reserveMetadataKeys(itemCount, budget, limits);
        const result = [];
        consumeMetadataBytes(2, budget, limits);
        for (let index = 0; index < itemCount; index += 1) {
            if (index > 0) {
                consumeMetadataBytes(1, budget, limits);
            }
            result.push(copyMetadataValue(items[index], depth + 1, budget, limits));
        }
        return result;
    }
    return copyMetadataObject(value, depth, budget, limits);
}
function copyMetadataObject(value, depth, budget, limits) {
    if (!isPlainRecord(value)) {
        throw new Error('metadata value');
    }
    const unknownEntries = value.entries;
    if (!Array.isArray(unknownEntries)) {
        throw new Error('metadata value');
    }
    const entries = unknownEntries;
    const entryCount = entries.length;
    reserveMetadataKeys(entryCount, budget, limits);
    const result = [];
    consumeMetadataBytes(2, budget, limits);
    for (let index = 0; index < entryCount; index += 1) {
        const entry = entries[index];
        if (!Array.isArray(entry) || entry.length !== 2) {
            throw new Error('metadata entry');
        }
        const key = entry[0];
        if (typeof key !== 'string') {
            throw new Error('metadata key');
        }
        if (index > 0) {
            consumeMetadataBytes(1, budget, limits);
        }
        consumeMetadataString(key, budget, limits);
        consumeMetadataBytes(1, budget, limits);
        result.push([key, copyMetadataValue(entry[1], depth + 1, budget, limits)]);
    }
    return { entries: result };
}
function reserveMetadataKeys(count, budget, limits) {
    if (!Number.isSafeInteger(count) || count < 0 || count > limits.maxMetadataKeys - budget.keys) {
        throw new Error('metadata keys');
    }
    budget.keys += count;
}
function consumeMetadataString(value, budget, limits) {
    const remaining = limits.maxMetadataBytes - budget.bytes;
    if (value.length + 2 > remaining) {
        throw new Error('metadata bytes');
    }
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw new Error('metadata value');
    }
    consumeMetadataBytes(budget.encoder.encode(serialized).byteLength, budget, limits);
}
function consumeMetadataBytes(bytes, budget, limits) {
    if (bytes > limits.maxMetadataBytes - budget.bytes) {
        throw new Error('metadata bytes');
    }
    budget.bytes += bytes;
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
function readMessageField(input, field) {
    return Reflect.get(input, field);
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
