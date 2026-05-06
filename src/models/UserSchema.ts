import mongoose, { Document, Model, Schema } from "mongoose";
import bcrypt from "bcryptjs";

// ─── TypeScript Interface ────────────────────────────────────────────────────

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  email: string;                  // login email
  password: string;               // hashed
  senderEmail: string;            // gmail they want to send FROM
  googleAppPassword: string;      // AES-encrypted Google App Password
  role: "user" | "admin";
  isVerified: boolean;
  emailsSentCount: number;
  createdAt: Date;
  updatedAt: Date;

  // Methods
  comparePassword(candidatePassword: string): Promise<boolean>;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const UserSchema = new Schema<IUser>(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      minlength: [2, "Name must be at least 2 characters"],
      maxlength: [50, "Name cannot exceed 50 characters"],
    },

    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Please enter a valid email address"],
    },

    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [8, "Password must be at least 8 characters"],
      select: false, // Never returned in queries by default
    },

    senderEmail: {
      type: String,
      lowercase: true,
      trim: true,
      match: [/^\S+@gmail\.com$/, "Sender email must be a valid Gmail address"],
    },

    googleAppPassword: {
      type: String,
      select: false,
    },

    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
    },

    isVerified: {
      type: Boolean,
      default: false,
    },

    emailsSentCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true, // auto createdAt + updatedAt
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

UserSchema.index({ email: 1 });
UserSchema.index({ role: 1 });
UserSchema.index({ createdAt: -1 });

// ─── Pre-save Hook: Hash password before saving ───────────────────────────────

UserSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
});

// ─── Instance Method: Compare password ───────────────────────────────────────

UserSchema.methods.comparePassword = async function (
  candidatePassword: string
): Promise<boolean> {
  return bcrypt.compare(candidatePassword, this.password);
};

// ─── Remove sensitive fields from JSON output ─────────────────────────────────

UserSchema.set("toJSON", {
  transform: (_doc, ret: Record<string, any>) => {
    delete ret.password;
    delete ret.googleAppPassword;
    delete ret.__v;
    return ret;
  },
});

// ─── Export ───────────────────────────────────────────────────────────────────
// Standard safe singleton pattern — never delete the model, just reuse it if
// it was already registered (avoids webpack HMR factory-undefined crash).
const User: Model<IUser> =
  (mongoose.models.User as Model<IUser>) ||
  mongoose.model<IUser>("User", UserSchema);

export default User;