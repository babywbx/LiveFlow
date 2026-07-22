import { InvalidPlaybackMetricsError } from '../shared/errors.js';
export function validatePlaybackMetrics(metrics, now) {
    requireFiniteNonNegative('currentTimeSeconds', metrics.currentTimeSeconds);
    requireFiniteNonNegative('bufferedAheadSeconds', metrics.bufferedAheadSeconds);
    requireFiniteNonNegative('liveEdgeDistanceSeconds', metrics.liveEdgeDistanceSeconds);
    if (!Number.isFinite(metrics.playbackRate) || metrics.playbackRate <= 0) {
        throw new InvalidPlaybackMetricsError('playbackRate');
    }
    if (metrics.stalledSince !== null &&
        (!Number.isFinite(metrics.stalledSince) ||
            metrics.stalledSince < 0 ||
            metrics.stalledSince > now)) {
        throw new InvalidPlaybackMetricsError('stalledSince');
    }
    if (metrics.droppedFrames !== null &&
        (!Number.isInteger(metrics.droppedFrames) || metrics.droppedFrames < 0)) {
        throw new InvalidPlaybackMetricsError('droppedFrames');
    }
}
function requireFiniteNonNegative(field, value) {
    if (!Number.isFinite(value) || value < 0) {
        throw new InvalidPlaybackMetricsError(field);
    }
}
