import { redirect } from 'next/navigation';

export default function Root() {
  // Server-side redirect — middleware handles auth check via HttpOnly cookie
  redirect('/dashboard');
}
