import { supabase } from './supabase';

export async function initAuthHero(buttonId: string, errorId: string) {
	const {
		data: { session },
	} = await supabase.auth.getSession();
	if (session) {
		location.replace('/dashboard');
		return;
	}

	document.getElementById(buttonId)!.addEventListener('click', async () => {
		const { error } = await supabase.auth.signInWithOAuth({
			provider: 'google',
			options: {
				redirectTo: `${location.origin}/auth/callback`,
			},
		});
		if (error) {
			const errorEl = document.getElementById(errorId)!;
			errorEl.textContent = error.message;
			errorEl.style.display = 'block';
		}
	});
}
