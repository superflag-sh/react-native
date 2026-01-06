import AsyncStorage from "@react-native-async-storage/async-storage"

/**
 * Cache key used for storing config
 */
export const CACHE_KEY = "superflag:cache:v1"

/**
 * Storage adapter using AsyncStorage.
 * All operations are wrapped in try/catch to prevent crashes
 * if AsyncStorage isn't ready or throws unexpectedly.
 */
export const storage = {
  async getItem(key: string): Promise<string | null> {
    try {
      return await AsyncStorage.getItem(key)
    } catch {
      return null
    }
  },

  async setItem(key: string, value: string): Promise<void> {
    try {
      await AsyncStorage.setItem(key, value)
    } catch {
      // Silently fail - caching is best-effort
    }
  },

  async removeItem(key: string): Promise<void> {
    try {
      await AsyncStorage.removeItem(key)
    } catch {
      // Silently fail
    }
  },
}
