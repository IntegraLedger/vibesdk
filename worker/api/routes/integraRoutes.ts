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
import { createSecureCookie } from '../../utils/authUtils';
import { validateToken } from '../../middleware/auth/auth';
import { CodingAgentController } from '../controllers/agent/controller';
import type { RouteContext } from '../types/route-context';

const ENGINE = 'https://engine.integraledger.com';
const MAX_PROMPT = 4000;
const MAX_BRIEF = 12000;
/** The only places a brief is read from: the engine's own addresses. */
const BRIEF_HOSTS = new Set(['engine.integraledger.com', 'engine.demos.integraledger.net']);

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
        // THE BRIEF (2026-09-25): the engine composes what the studio receives and keeps it; the door is given its address
        // (?brief=…, on the engine only) and reads it. A bare ?prompt= is still accepted for the people working on this.
        let prompt = (c.req.query('prompt') ?? '').trim().slice(0, MAX_PROMPT);
        const briefUrl = (c.req.query('brief') ?? '').trim();
        if (briefUrl !== '') {
            try {
                const u = new URL(briefUrl);
                if (u.protocol === 'https:' && BRIEF_HOSTS.has(u.hostname) && u.pathname.startsWith('/api/studio/brief/')) {
                    const res = await fetch(u.toString(), { headers: { accept: 'application/json' } });
                    const brief = res.ok ? ((await res.json()) as { prompt?: unknown }) : null;
                    if (typeof brief?.prompt === 'string') prompt = brief.prompt.trim().slice(0, MAX_BRIEF);
                }
            } catch (error) {
                console.error('integra brief could not be read', error);
            }
        }
        if (prompt === '') return c.redirect(`${ENGINE}/?tier=advanced&studio=no-brief`, 302);
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
            // The generation is started the way the app's own handler starts it, as the guest, in this same Worker: no
            // second request, so no CSRF token to carry and no door to knock on.
            const session = await validateToken(token, env);
            if (session === null) throw new Error('the guest session did not validate');
            const routeContext: RouteContext = {
                user: session.user,
                sessionId: session.sessionId,
                config: c.get('config'),
                pathParams: {},
                queryParams: new URL(request.url).searchParams,
            };
            const started = await CodingAgentController.startCodeGeneration(
                new Request(`${origin}/api/agent`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
                    body: JSON.stringify({ query: prompt }),
                }),
                env,
                c.executionCtx,
                routeContext,
            );
            const first = started.ok ? await firstJson(started) : null;
            const agentId = typeof first?.['agentId'] === 'string' ? (first['agentId'] as string) : null;
            const to = agentId === null ? `${ENGINE}/?tier=advanced&studio=could-not-start` : `${origin}/chat/${agentId}`;
            const response = new Response(null, { status: 302, headers: { location: to } });
            // The engine embeds the generation's page in a frame on its own address, so this cookie must travel into a
            // third-party frame: SameSite=None (with Secure), not the app's usual Lax.
            response.headers.append('Set-Cookie', createSecureCookie({ name: 'accessToken', value: token, maxAge: SessionService.config.sessionTTL, sameSite: 'None' }));
            return response;
        } catch (error) {
            console.error('integra start failed', error);
            return c.redirect(`${ENGINE}/?tier=advanced&studio=could-not-start`, 302);
        }
    });

    app.route('/api/integra', router);
}
