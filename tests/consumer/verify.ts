import { CONTRACT_VERSION, ContractVersionMismatchError, LiveFlowError } from '@babywbx/liveflow'
import { createContinuityController, DEFAULT_CONTINUITY_POLICY } from '@babywbx/liveflow/continuity'
import { createDanmakuEngine } from '@babywbx/liveflow/danmaku'
import { createDomDanmakuRenderer } from '@babywbx/liveflow/danmaku/dom'
import { createOverlayBudgetCoordinator, createOverlayEngine } from '@babywbx/liveflow/overlay'
import { createEventBannerPresenter } from '@babywbx/liveflow/overlay/banner'
import { createChromeVisibility } from '@babywbx/liveflow/chrome'
import { multiviewGridSpec } from '@babywbx/liveflow/multiview'
import { createNativeVideoAdapter } from '@babywbx/liveflow/native-video'
import { createDocumentPageActivity } from '@babywbx/liveflow/page-activity'
import { createArtPlayerAdapter } from '@babywbx/liveflow/artplayer'
import { createDPlayerAdapter } from '@babywbx/liveflow/dplayer'
import { createVideoJsAdapter } from '@babywbx/liveflow/videojs'
import { createXgPlayerAdapter } from '@babywbx/liveflow/xgplayer'

void [
  CONTRACT_VERSION,
  ContractVersionMismatchError,
  LiveFlowError,
  createContinuityController,
  DEFAULT_CONTINUITY_POLICY,
  createDanmakuEngine,
  createDomDanmakuRenderer,
  createOverlayBudgetCoordinator,
  createOverlayEngine,
  createEventBannerPresenter,
  createChromeVisibility,
  multiviewGridSpec,
  createNativeVideoAdapter,
  createDocumentPageActivity,
  createArtPlayerAdapter,
  createDPlayerAdapter,
  createVideoJsAdapter,
  createXgPlayerAdapter,
]
