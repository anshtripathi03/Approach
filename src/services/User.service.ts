import { IUser, UpdateCredentialsPayload } from "@/src/types/user.types";
import { PaginatedResponse } from "@/src/types/admin.types";
import { IEmailLog, EmailLogFilters } from "@/src/types/email.types";
import api from "@/src/lib/axios";
import { ICompany } from "@/src/types/admin.types";

// ─── User Service ─────────────────────────────────────────────────────────────

export const userService = {
  /**
   * GET /api/user
   * Returns the currently authenticated user's profile.
   */
  getProfile: async (): Promise<IUser> => {
    const { data } = await api.get<{ user: IUser }>("/user");
    return data.user;
  },

  /**
   * PUT /api/user/credentials
   * Updates senderEmail and/or googleAppPassword.
   * Verifies Gmail credentials against SMTP before saving.
   */
  updateCredentials: async (
    payload: UpdateCredentialsPayload,
  ): Promise<{ message: string; user: IUser }> => {
    const { data } = await api.put<{ message: string; user: IUser }>(
      "/user/credentials",
      payload,
    );
    return data;
  },

  /**
   * GET /api/user/sentEmails
   * Returns paginated email logs for the current user.
   */
  getSentEmails: async (
    filters?: EmailLogFilters,
  ): Promise<PaginatedResponse<IEmailLog>> => {
    const { data } = await api.get<PaginatedResponse<IEmailLog>>(
      "/user/sentEmails",
      { params: filters },
    );
    return data;
  },

  getSentEmailById: async (id: string): Promise<IEmailLog> => {
    const { data } = await api.get<{ data: IEmailLog }>(
      `/user/sentEmails/${id}`,
    );
    return data.data;
  },

  getNonSentCompanies: async (): Promise<ICompany[]> => {
    const { data } = await api.get<{ data: ICompany[]; pagination: any }>(
      "/companies/non-sent"
    );
    return data.data;
  },
};
