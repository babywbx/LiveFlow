export interface Destroyable {
    destroy(): void;
}
export interface AsyncDestroyable {
    destroy(): Promise<void>;
}
