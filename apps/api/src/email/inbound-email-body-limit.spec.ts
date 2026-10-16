// eslint-disable-next-line @typescript-eslint/no-require-imports
const express = require('express') as typeof import('express');
import * as request from 'supertest';
import {
    DEFAULT_INBOUND_EMAIL_BODY_LIMIT,
    INBOUND_EMAIL_WEBHOOK_PATH,
    resolveInboundEmailBodyLimit,
} from './inbound-email-body-limit';

/**
 * EW-P4-3 — the inbound-email webhooks get their own (larger) body limit,
 * mounted ahead of the tight global one, exactly as `main.ts` wires them.
 */
describe('resolveInboundEmailBodyLimit', () => {
    it('defaults to 25mb (the ingress proxy-body-size)', () => {
        expect(resolveInboundEmailBodyLimit(undefined)).toBe('25mb');
        expect(DEFAULT_INBOUND_EMAIL_BODY_LIMIT).toBe('25mb');
    });

    it('accepts a valid size within the ceiling', () => {
        expect(resolveInboundEmailBodyLimit('40mb', () => undefined)).toBe('40mb');
        expect(resolveInboundEmailBodyLimit('5242880', () => undefined)).toBe('5242880');
    });

    it.each(['512mb', '1gb', 'lots', '-1mb', '0'])(
        'falls back to the default (and warns) for %j',
        (value) => {
            const warn = jest.fn();
            expect(resolveInboundEmailBodyLimit(value, warn)).toBe('25mb');
            expect(warn).toHaveBeenCalledTimes(1);
        },
    );
});

describe('inbound-email body parsers ahead of the global ones', () => {
    function app() {
        const server = express();
        const limit = resolveInboundEmailBodyLimit(undefined);
        server.use(INBOUND_EMAIL_WEBHOOK_PATH, express.json({ limit }));
        server.use(INBOUND_EMAIL_WEBHOOK_PATH, express.urlencoded({ limit, extended: true }));
        server.use(express.json({ limit: '1mb' }));
        server.use(express.urlencoded({ limit: '1mb', extended: true }));
        server.post('/{*splat}', (req, res) => {
            res.json({ size: JSON.stringify(req.body ?? {}).length });
        });
        return server;
    }

    const big = { Attachments: [{ Content: 'A'.repeat(3 * 1024 * 1024) }] };

    it('accepts a 3 MB JSON body on the inbound webhook', async () => {
        const res = await request(app()).post('/api/email/inbound/postmark').send(big);
        expect(res.status).toBe(200);
        expect(res.body.size).toBeGreaterThan(3 * 1024 * 1024);
    });

    it('accepts a 3 MB form body on the inbound webhook', async () => {
        const res = await request(app())
            .post('/api/email/inbound/mailgun')
            .type('form')
            .send({ 'body-plain': 'B'.repeat(3 * 1024 * 1024) });
        expect(res.status).toBe(200);
    });

    it('keeps the tight global limit everywhere else', async () => {
        const res = await request(app()).post('/api/telemetry/funnel').send(big);
        expect(res.status).toBe(413);
    });
});
