"use client";

import { useCallback, useEffect } from "react";
import { useSession } from "next-auth/react";
import { useAuthStore } from "@/src/store/Authstore";
import { authService } from "@/src/services/Auth.service";
import { userService } from "@/src/services/User.service";
import { RegisterPayload, UpdateCredentialsPayload } from "@/src/types/user.types";
import { useCompanyStore } from "@/src/store/Companystore";

/**
 * ✅ SIMPLIFIED useAuth Hook
 * 
 * This hook:
 * 1. Gets session status from NextAuth
 * 2. Fetches full user profile from /api/user
 * 3. Stores profile in Zustand
 * 4. Exposes user, role, and all actions
 * 
 * Usage:
 *   const { user, isLoading, isAuthenticated, isAdmin, fetchProfile } = useAuth();
 */

export function useAuth() {
  const { data: session, status } = useSession();

  const { setNonSentCompanies, setNonSentLoading, setNonSentError } = useCompanyStore();

  const {
    user,
    isLoading,
    error,
    setUser,
    setLoading,
    setError,
    clearAuth,
  } = useAuthStore();

  // Check if session is authenticated
  const isSessionLoading = status === "loading";
  const isAuthenticated = status === "authenticated";

  // Check if user in store is admin
  const isAdmin = user?.role === "admin";

  /**
   * Fetch full user profile from /api/user endpoint
   * This includes role, emailsSentCount, senderEmail, etc.
   */
  const fetchProfile = useCallback(async () => {
    if (!isAuthenticated) {
      console.log("⏭️ Skipping profile fetch: not authenticated");
      return null;
    }

    setLoading(true);
    setError(null);
    try {
      console.log("📥 Fetching user profile...");
      const profile = await userService.getProfile();

      console.log("✅ Profile loaded:", {
        email: profile.email,
        role: profile.role,
      });

      setUser(profile);
      return profile;
    } catch (err: any) {
      console.error("❌ Failed to fetch profile:", err.message);
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, setUser, setLoading, setError]);

  const fetchNonSentCompanies = useCallback(async () => {
    setNonSentLoading(true);
    setNonSentError(null);
    try {
      const companies = await userService.getNonSentCompanies();
      setNonSentCompanies(companies);
      return companies;
    } catch (err: any) {
      setNonSentError(err.message);
      throw err;
    } finally {
      setNonSentLoading(false);
    }
  }, [setNonSentCompanies, setNonSentLoading, setNonSentError]);

  /**
   * On mount: If authenticated, fetch profile
   * This populates Zustand store with full user data
   */
  useEffect(() => {
    if (isAuthenticated && !user) {
      console.log("🚀 Auto-fetching profile on mount");
      // fetchProfile() rethrows after recording the error in the store (so
      // callers like login/register can react to it) — but this mount-time
      // call is fire-and-forget, so an uncaught rethrow here becomes an
      // unhandled promise rejection that crashes to the Next.js dev overlay.
      // The error is already captured via setError above; nothing more to do.
      fetchProfile().catch(() => {});
    }
  }, [isAuthenticated, user, fetchProfile]);

  /**
   * Register new user
   */
  const register = useCallback(
    async (payload: RegisterPayload) => {
      setLoading(true);
      setError(null);
      try {
        console.log("📝 Registering user:", payload.email);
        const result = await authService.register(payload);
        console.log("✅ Registration successful");
        return result;
      } catch (err: any) {
        console.error("❌ Registration failed:", err.message);
        setError(err.message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [setLoading, setError]
  );

  /**
   * Login user
   */
  const login = useCallback(
    async (email: string, password: string) => {
      setLoading(true);
      setError(null);
      try {
        console.log("🔐 Logging in:", email);
        const result = await authService.login(email, password);
        console.log("✅ Login successful");

        // After successful login, fetch full profile
        // (optional - will happen on next mount anyway)
        return result;
      } catch (err: any) {
        console.error("❌ Login failed:", err.message);
        setError(err.message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [setLoading, setError]
  );

  /**
   * Logout user
   */
  const logout = useCallback(async () => {
    setLoading(true);
    try {
      console.log("👋 Logging out...");
      await authService.logout();
      clearAuth();
      console.log("✅ Logout successful");
    } catch (err: any) {
      console.error("❌ Logout failed:", err.message);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [clearAuth, setLoading, setError]);

  /**
   * Update user credentials (senderEmail, googleAppPassword)
   */
  const updateCredentials = useCallback(
    async (payload: UpdateCredentialsPayload) => {
      setLoading(true);
      setError(null);
      try {
        console.log("✏️ Updating credentials...");
        const result = await userService.updateCredentials(payload);

        if (result.user) {
          setUser(result.user);
          console.log("✅ Credentials updated");
        }
        return result;
      } catch (err: any) {
        console.error("❌ Update failed:", err.message);
        setError(err.message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [setUser, setLoading, setError]
  );

  /**
   * Clear error state
   */
  const clearError = useCallback(() => {
    setError(null);
  }, [setError]);

  return {
    // ── Session status ─────────────────────────────────────────────────────
    session,
    isSessionLoading,
    isAuthenticated,

    // ── User profile (from Zustand store) ──────────────────────────────────
    user,
    isLoading,
    error,
    isAdmin, // ✅ Easy way to check if admin

    // ── Actions ────────────────────────────────────────────────────────────
    register,
    login,
    logout,
    fetchProfile,
    fetchNonSentCompanies,
    updateCredentials,
    clearError,
  };
}