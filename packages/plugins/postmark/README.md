# @ever-works/postmark-plugin

Postmark email provider for the Ever Works platform.

- **Capabilities**: `email-outbound`, `email-inbound`
- **Outbound**: POST `/email` on Postmark Server API
- **Inbound**: Postmark Inbound Streams webhook parser
- **Delivery events**: `Delivery`, `Bounce`, `SpamComplaint`, `Open`, `Click`

## Settings

| Key                    | Required | Description                                        |
| ---------------------- | -------- | -------------------------------------------------- |
| `apiKey`               | Yes      | Postmark Server API token                          |
| `defaultSenderDomain`  | No       | Default `From` domain                              |
| `inboundWebhookSecret` | Inbound  | Basic-Auth secret for inbound webhook verification |
| `inboundStreamId`      | No       | Specific inbound stream id                         |

Env-var fallbacks: `POSTMARK_API_KEY`, `POSTMARK_INBOUND_SECRET`.

**Inbound needs a secret.** With no `inboundWebhookSecret` / `POSTMARK_INBOUND_SECRET` at the resolved scope, inbound
and delivery-event webhooks are refused (`401`). Register the webhook URL with the credential embedded
(`https://postmark:<secret>@<your-domain>/api/email/inbound/postmark`). A local stack with no public webhook URL may opt
out with `EMAIL_INBOUND_ALLOW_UNSIGNED=true` (that exact string).

## Webhook URLs

Register at Postmark dashboard:

- Inbound: `https://<your-domain>/api/email/inbound/postmark`
- Delivery events: `https://<your-domain>/api/email/events/postmark`

Refs spec: [`docs/specs/features/email-providers/spec.md`](../../../docs/specs/features/email-providers/spec.md) §6.
