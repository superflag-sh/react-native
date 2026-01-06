import AsyncStorage from "@react-native-async-storage/async-storage"

/**
 * Cache key used for storing config
 */
export const CACHE_KEY = "superflag:cache:v1"

/**
 * Storage adapter using AsyncStorage.
 * This is a static import - no dynamic detection needed.
 */
export const storage = {
  async getItem(key: string): Promise<string | null> {
    return AsyncStorage.getItem(key)
  },

  async setItem(key: string, value: string): Promise<void> {
    await AsyncStorage.setItem(key, value)
  },

  async removeItem(key: string): Promise<void> {
    await AsyncStorage.removeItem(key)
  },
}
