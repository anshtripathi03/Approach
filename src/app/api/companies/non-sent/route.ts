import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/src/lib/auth";
import { connectDB } from "@/src/lib/db";
import Company from "@/src/models/CompanySchema";
import SentEmail from "@/src/models/SentEmailSchema";

// ── GET /api/companies/non-sent ───────────────────────────────────────────────
// Returns companies that the current user has never sent an email to.
// Paginated: 100 per page. Pass ?page=1, ?page=2, etc. for load-more.
//
// Response shape:
// {
//   data: ICompany[],
//   pagination: { page, limit, total, totalPages, hasNextPage }
// }

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    // 1. Auth check
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = session.user.id;

    await connectDB();

    // 3. Collect all company IDs the user has already sent to
    const sentDocs = await SentEmail.find({ sentBy: userId })
      .select("company")
      .lean();

    const sentCompanyIds = sentDocs.map((d) => d.company);

    // 4. Query companies NOT in the sent list, active only
    const filter = {
      isActive: true,
      ...(sentCompanyIds.length > 0 ? { _id: { $nin: sentCompanyIds } } : {}),
    };

    const companies = await Company.find(filter)
      .select("_id name email category website location tags createdAt")
      .sort({ createdAt: -1 })
      .lean();

    const total = companies.length;


    return NextResponse.json({
      data: companies,
      pagination: {
        page: 1,
        limit: total,
        total,
        totalPages: 1,
        hasNextPage: false,
      },
    });
  } catch (error) {
    console.error("[GET /api/companies/non-sent ERROR]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
