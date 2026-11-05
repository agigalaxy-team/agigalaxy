// Compile-time contract for the host-owned OpenCode 2.2.3 TUI module.
// The runtime implementation is supplied by OpenCode; this declaration covers
// only the public surface used by the Galaxy V2 adapter.
declare module '@opencode/plugin/tui' {
  type Cleanup = () => void | Promise<void>;
  type LocationRef = { readonly directory: string; readonly [key: string]: unknown };
  type Route = { readonly type: 'home' } | { readonly type: 'session'; readonly sessionID: string } |
    { readonly type: 'plugin'; readonly id: string; readonly name: string; readonly data?: Record<string, unknown> };
  type Message = { readonly id: string; readonly type: string; readonly time: { readonly created: number; readonly completed?: number };
    readonly [key: string]: unknown };
  type Command = { readonly id?: string; readonly title?: string; readonly description?: string; readonly group?: string;
    readonly enabled?: boolean | (() => boolean); readonly bind?: false | string; readonly palette?: true;
    readonly slash?: { readonly name: string; readonly aliases?: string[]; readonly arguments?: true };
    readonly run: (input?: string, event?: unknown) => void | false | Promise<void> };
  type Layer = { readonly mode?: string; readonly enabled?: boolean | (() => boolean); readonly commands?: readonly Command[];
    readonly bindings?: readonly string[] };
  interface Context {
    readonly app: { readonly version: string };
    readonly renderer: { readonly width: number; readonly height: number };
    readonly location: LocationRef | undefined;
    readonly client: { readonly message: { list(input: { sessionID: string; limit?: number; cursor?: string; order?: 'asc' | 'desc' },
      options?: { signal?: AbortSignal }): Promise<{ data: Message[]; cursor: { next?: string | null } }> } };
    readonly data: {
      listen(handler: (event: { details: { type: string; data: Record<string, unknown> } }) => void): () => void;
      readonly session: { get(sessionID: string): unknown; status(sessionID: string): 'idle' | 'running';
        readonly message: { list(sessionID: string): Message[]; get(sessionID: string, messageID: string): Message | undefined;
          sync(sessionID: string): Promise<void> } };
      readonly location: { readonly mcp: { readonly server: { list(location?: LocationRef): unknown[] | undefined } } };
    };
    readonly keymap: { layer(factory: () => Layer): void; readonly mode: { current(): string; push(mode: string): () => void } };
    readonly storage: { memory<Value extends object>(key: string, options: { readonly initial: Value }):
      readonly [Value, (mutation: (draft: Value) => void) => void] };
    readonly ui: {
      readonly router: { current(): Route; navigate(destination: Route | Omit<Extract<Route, { type: 'plugin' }>, 'id'>): void };
      readonly toast: { show(input: { message: string; title?: string; variant?: 'info' | 'success' | 'warning' | 'error'; duration?: number }): void };
      readonly dialog: { set(options: { size?: 'medium' | 'large' | 'xlarge'; centered?: boolean }): void; clear(): void;
        confirm(options: { title: string; message: string }): Promise<boolean | undefined>;
        prompt(options: { title: string; placeholder?: string; value?: string }): Promise<string | undefined>;
        select<Value>(options: { title: string; options: readonly { title: string; value: Value; description?: string; disabled?: boolean }[] }): Promise<Value | undefined> };
    };
  }
  interface Definition { readonly id: string; readonly setup: (context: Context) => Cleanup | void | Promise<Cleanup | void> }
  export const Plugin: { define(plugin: Definition): Definition };
}
