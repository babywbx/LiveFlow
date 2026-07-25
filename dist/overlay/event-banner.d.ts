import type { EventBannerLimits, EventBannerPresenter, EventBannerPresenterOptions } from './event-banner-types.js';
export declare const DEFAULT_EVENT_BANNER_LIMITS: Readonly<EventBannerLimits>;
export declare const MAX_EVENT_BANNER_LIMITS: Readonly<EventBannerLimits>;
export declare function createEventBannerPresenter(options: EventBannerPresenterOptions): EventBannerPresenter;
