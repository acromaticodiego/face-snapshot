/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_CAPTURE_FPS?: string;
  readonly VITE_TERMINAL_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
