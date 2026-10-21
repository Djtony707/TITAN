import { NextResponse } from 'next/server';

// This retired standalone UI has no authenticated, scoped gateway integration.
// Never load signing credentials or issue anonymous tokens, even in development.
export const revalidate = 0;

export async function POST(_req: Request) {
  return NextResponse.json(
    {
      error:
        'Legacy standalone voice token issuance is on security hold. Use the authenticated TITAN gateway voice interface.',
    },
    { status: 503, headers: { 'Cache-Control': 'no-store' } }
  );
}
