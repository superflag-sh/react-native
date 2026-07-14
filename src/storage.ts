/**
 * Storage adapter for React Native using AsyncStorage.
 *
 * AsyncStorage is loaded lazily so importing the SDK never touches the native
 * bridge, and every operation fails closed so storage cannot crash the app.
 */

export const CACHE_KEY = "superflag:cache:v1"

/**
 * Lazy-load AsyncStorage to avoid module-load-time crashes.
 * Static imports run before the native bridge is ready, causing crashes in production.
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
