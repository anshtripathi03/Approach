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

const PAGE_LIMIT = 100;

export async function GET(req: NextRequest) {
  try {
    // 1. Auth check
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = session.user.id;

    // 2. Parse pagination query param
    const { searchParams } = new URL(req.url);
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
    const skip = (page - 1) * PAGE_LIMIT;

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

    const [companies, total] = await Promise.all([
      Company.find(filter)
        .select("_id name email category website location tags createdAt")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(PAGE_LIMIT)
        .lean(),
      Company.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(total / PAGE_LIMIT);

    return NextResponse.json({
      data: companies,
      pagination: {
        page,
        limit: PAGE_LIMIT,
        total,
        totalPages,
        hasNextPage: page < totalPages,
      },
    });
  } catch (error) {
    console.error("[GET /api/companies/non-sent ERROR]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
