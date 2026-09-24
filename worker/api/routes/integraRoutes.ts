/**
 * INTEGRA'S DOOR INTO THE CODE STUDIO (2026-09-24). The visitor never sees this app's stock front page or a sign-in:
 * the engine (engine.integraledger.com) holds the conversation, and when the visitor asks for a generated storefront
 * it sends them here with their description. This route makes a guest account for the visit (a random address under
 * guest.integraledger.com, a random password, kept by nobody), starts the generation as that guest with the
 * description as the first turn, sets the session cookie, and lands the visitor on the generation's own page.
 * Berger, 2026-09-24: "we should never present a random chat, also why the login".
 */
import { Hono } from 'hono';
import { AppEnv } from '../../types/appenv';
import { AuthConfig, setAuthLevel } from '../../middleware/auth/routeAuth';
import { AuthService } from '../../database/services/AuthService';
import { SessionService } from '../../database/services/SessionService';
import { setSecureAuthCookies } from '../../utils/authUtils';

const ENGINE = 'https://engine.integraledger.com';
const MAX_PROMPT = 4000;

/** The first JSON object a streamed answer carries (the agent's id is in it), read without waiting for the rest. */
async function firstJson(res: Response): Promise<Record<string, unknown> | null> {
    const reader = res.body?.getReader();
    if (!reader) return null;
    const decoder = new TextDecoder();
    let text = '';
    for (let i = 0; i < 40; i++) {
        const { value, done } = await reader.read();
        if (value) text += decoder.decode(value, { stream: true });
        const m = /\{[^\n]*\}/.exec(text);
        if (m) {
            try {
                const parsed = JSON.parse(m[0]) as Record<string, unknown>;
                void reader.cancel().catch(() => undefined);
                return parsed;
            } catch {
                /* not a whole object yet */
            }
        }
        if (done) break;
    }
    void reader.cancel().catch(() => undefined);
    return null;
}

export function setupIntegraRoutes(app: Hono<AppEnv>): void {
    const router = new Hono<AppEnv>();

    router.get('/start', setAuthLevel(AuthConfig.public), async (c) => {
        const prompt = (c.req.query('prompt') ?? '').trim().slice(0, MAX_PROMPT);
        if (prompt === '') return c.redirect(`${ENGINE}/?tier=advanced`, 302);
        const env = c.env;
        const request = c.req.raw;
        try {
            const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
            const auth = new AuthService(env);
            const result = await auth.register(
                { email: `guest-${id}@guest.integraledger.com`, password: `Gx9!${crypto.randomUUID()}${crypto.randomUUID()}`, name: 'Guest' },
                request,
            );
            const token = result.accessToken;
            const origin = new URL(request.url).origin;
            const started = await fetch(`${origin}/api/agent`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}`, cookie: `accessToken=${token}` },
                body: JSON.stringify({ query: prompt }),
            });
            const first = started.ok ? await firstJson(started) : null;
            const agentId = typeof first?.['agentId'] === 'string' ? (first['agentId'] as string) : null;
            const to = agentId === null ? `${ENGINE}/?tier=advanced&studio=could-not-start` : `${origin}/chat/${agentId}`;
            const response = new Response(null, { status: 302, headers: { location: to } });
            setSecureAuthCookies(response, { accessToken: token, accessTokenExpiry: SessionService.config.sessionTTL });
            return response;
        } catch (error) {
            console.error('integra start failed', error);
            return c.redirect(`${ENGINE}/?tier=advanced&studio=could-not-start`, 302);
        }
    });

    app.route('/api/integra', router);
}
