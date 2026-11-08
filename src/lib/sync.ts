import { api } from './api';

/** Ask the server to index what just confirmed on-chain, so every page reflects it immediately. */
export async function syncChain() {
  try {
    await api('/chain/sync', { body: {} });
  } catch {
    /* the background indexers will catch up within a few seconds */
  }
}
