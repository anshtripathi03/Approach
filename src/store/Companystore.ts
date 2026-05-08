import { create } from "zustand";
import { ICompany } from "@/src/types/admin.types";

interface CompanyState {
  nonSentCompanies: ICompany[];
  nonSentLoading: boolean;
  nonSentError: string | null;
  nonSentLoaded: boolean;

  setNonSentCompanies: (companies: ICompany[]) => void;
  setNonSentLoading: (loading: boolean) => void;
  setNonSentError: (error: string | null) => void;
}

export const useCompanyStore = create<CompanyState>((set) => ({
  nonSentCompanies: [],
  nonSentLoading: false,
  nonSentError: null,
  nonSentLoaded: false,

  setNonSentCompanies: (nonSentCompanies) =>
    set({ nonSentCompanies, nonSentLoaded: true }),
  setNonSentLoading: (nonSentLoading) => set({ nonSentLoading }),
  setNonSentError: (nonSentError) => set({ nonSentError }),
}));