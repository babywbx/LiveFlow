import type { LivePlayerAdapter, LiveSource } from '../continuity/types.js';
import { type MediaSessionAdapterOptions, type ResourceEvent, type VideoElementLike } from './media-session-adapter.js';
export interface ManagedPlayerSurface<Player> {
    stage(player: Player): void;
    reveal(player: Player, previous: Player): void;
    remove(player: Player): void;
}
export interface ManagedPlayerOperations {
    readonly createCandidate: string;
    readonly releaseFailedCandidate: string;
    readonly releaseInstance: string;
}
export interface ManagedPlayerContract<Player> {
    readonly scope: string;
    readonly operations: ManagedPlayerOperations;
    readonly initialPlayer: Player;
    readonly surface: ManagedPlayerSurface<Player>;
    readonly createPlayer: (source: LiveSource, generation: number) => Player | Promise<Player>;
    readonly video: (player: Player) => VideoElementLike;
    readonly subscribe: (player: Player, listener: (event: ResourceEvent) => void) => () => void;
    readonly destroyPlayer: (player: Player) => void;
}
export declare function createManagedPlayerAdapter<Player>(contract: ManagedPlayerContract<Player>, options: MediaSessionAdapterOptions): LivePlayerAdapter;
export type ManagedEventHandler = (...args: readonly unknown[]) => void;
export interface ManagedEventTarget {
    on(event: string, handler: ManagedEventHandler): void;
    off?(event: string, handler: ManagedEventHandler): void;
}
export declare function bindManagedEvents(scope: string, label: string, target: ManagedEventTarget, registrations: ReadonlyArray<readonly [string, ManagedEventHandler]>): () => void;
