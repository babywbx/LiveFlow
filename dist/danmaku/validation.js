import { InvalidDanmakuConfigurationError, InvalidDanmakuMessageError } from './errors.js';
import { normalizeHexColor } from './hex-color.js';
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
    scrollLaneSelection: 'first-fit',
    fixedDurationMs: 4_000,
    stackAnchor: 'bottom-left',
    stackGap: 4,
    stackGlideMs: 300,
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
    const { scrollDurationMs, scrollDurationJitterMs, scrollOverlapStartRatio, scrollLaneSelection, stackAnchor, stackGap, stackGlideMs, ...positivePolicy } = policy;
    if (stackAnchor !== undefined && !/^(bottom|top)-(left|right)$/.test(stackAnchor)) {
        throw new InvalidDanmakuConfigurationError('policy.stackAnchor');
    }
    validateNonNegative(stackGap, 'policy.stackGap');
    validateNonNegative(stackGlideMs, 'policy.stackGlideMs');
    if (scrollLaneSelection !== undefined &&
        scrollLaneSelection !== 'first-fit' &&
        scrollLaneSelection !== 'freest') {
        throw new InvalidDanmakuConfigurationError('policy.scrollLaneSelection');
    }
    if (scrollDurationMs !== undefined &&
        scrollDurationMs !== null &&
        (!Number.isFinite(scrollDurationMs) || scrollDurationMs < 1)) {
        throw new InvalidDanmakuConfigurationError('policy.scrollDurationMs');
    }
    validateNonNegative(scrollDurationJitterMs, 'policy.scrollDurationJitterMs');
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
function validateNonNegative(value, field) {
    if (value !== undefined && value !== null && (!Number.isFinite(value) || value < 0)) {
        throw new InvalidDanmakuConfigurationError(field);
    }
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
    const result = {
        message: required,
        metadataDiscarded: false,
        identitiesTruncated: false,
        colorDiscarded: false,
    };
    copyIdentities(input.identities, result, limits.maxBadgesPerMessage);
    copyMetadata(input, result, limits);
    copyColor(input.color, result.message, 'color', result);
    copySender(input.sender, result);
    return result;
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
    const id = input.id;
    const receivedAt = input.receivedAt;
    const text = input.text;
    const mode = input.mode;
    const priority = input.priority;
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
function copySender(input, result) {
    if (input === undefined)
        return;
    if (!isPlainRecord(input)) {
        throw new InvalidDanmakuMessageError('sender');
    }
    const sender = {};
    const displayName = input.displayName;
    const avatarKey = input.avatarKey;
    if (displayName !== undefined) {
        validateBoundedString(displayName, 'sender.displayName', MAX_NAME_LENGTH, true);
        sender.displayName = displayName;
    }
    if (avatarKey !== undefined) {
        validateBoundedString(avatarKey, 'sender.avatarKey', MAX_ASSET_KEY_LENGTH, false);
        sender.avatarKey = avatarKey;
    }
    result.message.sender = sender;
    copyColor(input.color, sender, 'sender.color', result);
}
function copyIdentities(input, result, limit) {
    if (input === undefined)
        return;
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
        validateBoundedString(kind, 'identities.kind', MAX_IDENTITY_KIND_LENGTH, false);
        validateBoundedString(label, 'identities.label', MAX_IDENTITY_LABEL_LENGTH, true);
        if (level !== undefined &&
            (typeof level !== 'number' || !Number.isSafeInteger(level) || level < 0)) {
            throw new InvalidDanmakuMessageError('identities.level');
        }
        if (variant !== undefined) {
            validateBoundedString(variant, 'identities.variant', MAX_VARIANT_LENGTH, false);
        }
        if (assetKey !== undefined) {
            validateBoundedString(assetKey, 'identities.assetKey', MAX_ASSET_KEY_LENGTH, false);
        }
        identities.push({
            kind,
            label,
            ...(level === undefined ? {} : { level }),
            ...(variant === undefined ? {} : { variant }),
            ...(assetKey === undefined ? {} : { assetKey }),
        });
    }
    result.message.identities = identities;
    result.identitiesTruncated = identityCount > limit;
}
function copyMetadata(input, result, limits) {
    try {
        const metadata = input.metadata;
        if (metadata === undefined)
            return;
        const budget = {
            remainingKeys: limits.maxMetadataKeys,
            remainingBytes: limits.maxMetadataBytes,
        };
        result.message.metadata = copyMetadataObject(metadata, 0, budget, limits);
    }
    catch {
        result.metadataDiscarded = true;
    }
}
function copyMetadataValue(value, depth, budget, limits) {
    if (typeof value === 'string') {
        consumeMetadataString(value, budget);
        return value;
    }
    if (value === null ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))) {
        consumeMetadataBytes(String(value).length, budget);
        return value;
    }
    if (depth >= limits.maxMetadataDepth) {
        rejectMetadata();
    }
    if (Array.isArray(value)) {
        const items = value;
        const itemCount = items.length;
        reserveMetadataEntries(itemCount, budget);
        const result = [];
        for (let index = 0; index < itemCount; index += 1) {
            result.push(copyMetadataValue(items[index], depth + 1, budget, limits));
        }
        return result;
    }
    return copyMetadataObject(value, depth, budget, limits);
}
function copyMetadataObject(value, depth, budget, limits) {
    if (!isPlainRecord(value)) {
        rejectMetadata();
    }
    const unknownEntries = value.entries;
    if (!Array.isArray(unknownEntries)) {
        rejectMetadata();
    }
    const entries = unknownEntries;
    const entryCount = entries.length;
    reserveMetadataEntries(entryCount, budget);
    consumeMetadataBytes(entryCount, budget);
    const result = [];
    for (let index = 0; index < entryCount; index += 1) {
        const entry = entries[index];
        if (!Array.isArray(entry) || entry.length !== 2) {
            rejectMetadata();
        }
        const key = entry[0];
        if (typeof key !== 'string') {
            rejectMetadata();
        }
        consumeMetadataString(key, budget);
        result.push([key, copyMetadataValue(entry[1], depth + 1, budget, limits)]);
    }
    return { entries: result };
}
function reserveMetadataEntries(count, budget) {
    if (!Number.isSafeInteger(count) || count < 0 || count > budget.remainingKeys) {
        rejectMetadata();
    }
    budget.remainingKeys -= count;
    consumeMetadataBytes(2 + Math.max(0, count - 1), budget);
}
function consumeMetadataString(value, budget) {
    consumeMetadataBytes(value.length + 2, budget);
    const serialized = JSON.stringify(value);
    let extraBytes = serialized.length - value.length - 2;
    const firstMultibyte = serialized.search(/[\u0080-\uffff]/);
    if (firstMultibyte >= 0) {
        for (let index = firstMultibyte; index < serialized.length; index += 1) {
            const unit = serialized.charCodeAt(index);
            if (unit > 0x7f) {
                extraBytes += unit < 0x800 || (unit >= 0xd800 && unit <= 0xdfff) ? 1 : 2;
            }
        }
    }
    consumeMetadataBytes(extraBytes, budget);
}
function rejectMetadata() {
    throw new InvalidDanmakuMessageError('metadata');
}
function consumeMetadataBytes(bytes, budget) {
    budget.remainingBytes -= bytes;
    if (budget.remainingBytes < 0)
        rejectMetadata();
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
function copyColor(color, target, field, result) {
    if (color === undefined)
        return;
    if (typeof color !== 'string')
        throw new InvalidDanmakuMessageError(field);
    const normalized = normalizeHexColor(color);
    if (normalized === null)
        result.colorDiscarded = true;
    else
        target.color = normalized;
}
function validateBoundedString(value, field, maxLength, allowEmpty) {
    if (typeof value !== 'string' ||
        (!allowEmpty && value.length === 0) ||
        value.length > maxLength) {
        throw new InvalidDanmakuMessageError(field);
    }
}
