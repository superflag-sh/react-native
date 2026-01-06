/**
 * Cache key used for storing config
 */
export const CACHE_KEY = "superflag:cache:v1"

/**
 * Lazy-load AsyncStorage to avoid module-load-time crashes.
 * Using require() instead of import defers native module resolution
 * until the function is called, ensuring the native bridge is ready.
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
