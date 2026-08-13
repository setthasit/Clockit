import {api} from '@/api/client';
import type {LatLng} from '@/api/types';

// The phone number itself is never sent — the server reduces it to has_phone
// (backend/internal/user/handler.go newProfile).
export type Profile = {
  id: string;
  email: string;
  name: string;
  has_phone: boolean;
};

export type MembershipEmployer = {
  id: string;
  name: string;
  // Returned deliberately so the app can show live distance before clock-in (design §4.2).
  anchor: LatLng;
  // IANA name; the employer's timezone defines day boundaries.
  timezone: string;
};

export type Membership = {
  id: string;
  // /v1/me returns active memberships only (user/store.go ActiveMemberships), so screens
  // never filter. Widen to 'active' | 'invited' | 'removed' if that ever stops being true.
  status: 'active';
  employer: MembershipEmployer;
};

export type Me = {
  user: Profile;
  memberships: Membership[];
};

// Returns the envelope rather than unwrapping: the session store keeps both halves,
// so there is no single "useful payload" to pick.
export function getMe(): Promise<Me> {
  return api<Me>('/v1/me');
}

// Both fields optional, but empty/whitespace-only is rejected 400 — there is no way to
// clear a phone in v1.
export async function patchMe(body: {name?: string; phone?: string}): Promise<Profile> {
  const {user} = await api<{user: Profile}>('/v1/me', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return user;
}
