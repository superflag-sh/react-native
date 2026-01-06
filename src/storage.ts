/**
 * Storage adapter for React Native using AsyncStorage.
 *
 * IMPORTANT: See docs/react-native-library-rules.md for why this code is structured this way.
 * - Uses lazy require() instead of static import (Rule 2)
 * - All operations wrapped in try/catch (Rule 4)
 */

export const CACHE_KEY = "superflag:cache:v1"

/**
 * Lazy-load AsyncStorage to avoid module-load-time crashes.
 * Static imports run before the native bridge is ready, causing crashes in production.
 * See: docs/react-native-library-rules.md#rule-2-lazy-load-native-modules
 */
function getAsyncStorage() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@react-native-async-storage/async-storage").default
}

export const storage = {
  async getItem(key: string): Promise<string | null> {
    try {
      return await getAsyncStorage().getItem(key)
    } catch {
      return null
    }
  },

  async setItem(key: string, value: string): Promise<void> {
    try {
      await getAsyncStorage().setItem(key, value)
    } catch {
      // Silently fail - don't crash the app
    }
  },

  async removeItem(key: string): Promise<void> {
    try {
      await getAsyncStorage().removeItem(key)
    } catch {
      // Silently fail
    }
  },
}
