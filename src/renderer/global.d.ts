import type { OmpApi } from '../shared/ipc-channels';

declare global {
  interface Window {
    omp: OmpApi;
  }
}

export {};
