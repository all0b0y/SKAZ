/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 'kb' starts the new Knowledge Wiki interface (frontend/src/kb); anything else the current App. */
  readonly VITE_SKAZ_UI?: string;
}
