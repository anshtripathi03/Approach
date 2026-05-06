import mongoose, { Document, Model, Schema } from "mongoose";

export const COMPANY_CATEGORIES = [
  "Technology",
  "Finance",
  "Healthcare",
  "Education",
  "Marketing",
  "E-Commerce",
  "Logistics",
  "Media",
  "Real Estate",
  "Manufacturing",
  "Consulting",
  "Other",
] as const;

export type CompanyCategory = (typeof COMPANY_CATEGORIES)[number];

// ─── Interface ────────────────────────────────────────────────────────────────

export interface ICompany extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  email: string;
  category: string[];           // ← array now
  website?: string;
  description?: string;
  location?: string;
  addedBy: mongoose.Types.ObjectId;
  isActive: boolean;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const CompanySchema = new Schema<ICompany>(
  {
    name: {
      type: String,
      required: [true, "Company name is required"],
      trim: true,
      minlength: [2, "Company name must be at least 2 characters"],
      maxlength: [100, "Company name cannot exceed 100 characters"],
    },

    email: {
      type: String,
      required: [true, "Company email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Please enter a valid email address"],
    },

    // ✅ Array field — enum doesn't work on [String] in Mongoose,
    //    so we use a custom validator instead
    category: {
      type: [String],
      default: [],
      validate: [
        {
          // Must have at least one entry
          validator: (arr: string[]) => Array.isArray(arr) && arr.length > 0,
          message: "At least one category is required",
        },
        {
          // Every entry must be a valid category
          // [...COMPANY_CATEGORIES] spreads the readonly tuple into a plain string[]
          validator: (arr: string[]) =>
            arr.every((c) => ([...COMPANY_CATEGORIES] as string[]).includes(c)),
          message: "One or more categories are not valid",
        },
      ],
    },

    website: {
      type: String,
      trim: true,
      match: [
        /^https?:\/\/.+/,
        "Please enter a valid URL (must start with http/https)",
      ],
    },

    description: {
      type: String,
      trim: true,
      maxlength: [500, "Description cannot exceed 500 characters"],
    },

    location: {
      type: String,
      trim: true,
      maxlength: [100, "Location cannot exceed 100 characters"],
    },

    addedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "addedBy (admin user) is required"],
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    tags: {
      type: [String],
      default: [],
    },
  },
  { timestamps: true },
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

CompanySchema.index({ email: 1 });
CompanySchema.index({ category: 1 });
CompanySchema.index({ isActive: 1 });
CompanySchema.index({ createdAt: -1 });
CompanySchema.index(
  { name: "text", tags: "text", location: "text" },
  { name: "company_text_index" },
);

// ─── Statics ──────────────────────────────────────────────────────────────────

CompanySchema.statics.findActive = function () {
  return this.find({ isActive: true });
};

// ─── JSON output ──────────────────────────────────────────────────────────────

CompanySchema.set("toJSON", {
  transform: (_doc, ret: Record<string, any>) => {
    delete ret.__v;
    return ret;
  },
});

// ─── Export ───────────────────────────────────────────────────────────────────

const Company: Model<ICompany> =
  mongoose.models.Company || mongoose.model<ICompany>("Company", CompanySchema);

export default Company;
