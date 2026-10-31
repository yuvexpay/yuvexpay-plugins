import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderAction } from "../scripts/render.mjs";

const PLUGIN_DIR = join(process.cwd(), "plugins");

const PLUGIN_IDS = readdirSync(PLUGIN_DIR)
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.slice(0, -".json".length));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function manifest(id) {
  return JSON.parse(readFileSync(join(PLUGIN_DIR, `${id}.json`), "utf8"));
}

function actionFor(id, event) {
  const found = manifest(id).actions.find((action) => action.on === event);
  assert.ok(found, `${id} has no action for ${event}`);
  return found;
}

function envelope(overrides = {}) {
  return {
    id: "evt_1",
    type: "payment.paid",
    version: 1,
    createdAt: "2026-07-26T18:30:00.000Z",
    companyId: "co_1",
    livemode: true,
    data: {
      payment: {
        id: "pay_1",
        txId: "tx_1",
        status: "PAID",
        method: "PIX",
        currency: "BRL",
        amountCents: 4990,
        feeCents: 249,
        netAmountCents: 4741,
        description: "Plano Pro",
        createdAt: "2026-07-26T18:00:00.000Z",
        paidAt: "2026-07-26T18:29:00.000Z",
      },
    },
    tracking: {
      utmSource: "facebook",
      utmMedium: "cpc",
      utmCampaign: "bf",
      utmTerm: null,
      utmContent: null,
      src: "abc",
      sck: null,
      fbclid: "IwAR2example",
      gclid: null,
      ttclid: "E.C.P.v3fQ2RHacdksKfofPmlyuStIIHJ4Af1tKYxF9zz2c2PLx1Oaw15oHpcfl5AH",
      gaClientId: "1234567890.9876543210",
      fbp: "fb.1.1596403881668.1116446470",
      fbc: "fb.1.1596403881668.IwAR2example",
      clientIp: "203.0.113.10",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
    },
    customer: {
      id: "cus_1",
      name: "Fulano de Tal",
      contact: { email: "Fulano@Example.COM", phone: "+55 11 99999-8888", phoneE164: "+5511999998888" },
      document: { value: "529.982.247-25", type: "CPF" },
      institution: null,
    },
    ...overrides,
  };
}

const ANONYMOUS_HOSTED_CHECKOUT = envelope({
  type: "payment.created",
  customer: { id: null, name: null, contact: null, document: null, institution: null },
});

const BACKEND_WITHOUT_ATTRIBUTION_FIELDS = {
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  utmTerm: null,
  utmContent: null,
  src: null,
  sck: null,
  fbclid: null,
  gclid: null,
  ttclid: null,
  clientIp: "203.0.113.10",
  userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
};

const UTMIFY_PAYMENT_METHODS = ["credit_card", "boleto", "pix", "paypal", "free_price", "unknown"];
const UTMIFY_STATUSES = ["waiting_payment", "paid", "refused", "refunded", "chargedback"];
const UTMIFY_DATE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

describe("utmify", () => {
  const plugin = manifest("utmify");

  for (const event of ["payment.created", "payment.paid", "payment.refunded"]) {
    test(`${event} matches the documented order schema`, () => {
      const action = actionFor("utmify", event);
      const { skipped, body } = renderAction(
        plugin,
        action,
        envelope({ type: event }),
        { apiToken: "tok" },
      );

      assert.equal(skipped, false);

      assert.ok(UTMIFY_PAYMENT_METHODS.includes(body.paymentMethod), body.paymentMethod);
      assert.ok(UTMIFY_STATUSES.includes(body.status), body.status);

      assert.match(body.createdAt, UTMIFY_DATE);
      assert.doesNotMatch(body.createdAt, /[TZ]/);
      for (const field of ["approvedDate", "refundedAt"]) {
        if (body[field] !== null) assert.match(body[field], UTMIFY_DATE);
      }

      assert.equal(typeof body.orderId, "string");
      assert.equal(typeof body.platform, "string");

      assert.equal(typeof body.customer.name, "string");
      assert.equal(typeof body.customer.email, "string");
      assert.ok(body.customer.name.length > 0);
      assert.ok(body.customer.email.length > 0);

      assert.equal(typeof body.isTest, "boolean");

      assert.ok(Array.isArray(body.products) && body.products.length > 0);
      for (const product of body.products) {
        assert.equal(typeof product.id, "string");
        assert.equal(typeof product.name, "string");
        assert.ok(product.name.length > 0);
        assert.equal(typeof product.quantity, "number");
        assert.equal(typeof product.priceInCents, "number");
        assert.ok(Number.isInteger(product.priceInCents));
      }

      for (const field of ["totalPriceInCents", "gatewayFeeInCents", "userCommissionInCents"]) {
        assert.equal(typeof body.commission[field], "number", field);
        assert.ok(Number.isInteger(body.commission[field]), field);
      }

      assert.ok(Object.hasOwn(body, "trackingParameters"));
    });
  }

  test("prices stay in cents and are never converted to major units", () => {
    const action = actionFor("utmify", "payment.paid");
    const { body } = renderAction(plugin, action, envelope(), { apiToken: "tok" });
    assert.equal(body.products[0].priceInCents, 4990);
    assert.equal(body.commission.totalPriceInCents, 4990);
    assert.equal(body.commission.gatewayFeeInCents, 249);
    assert.equal(body.commission.userCommissionInCents, 4741);
  });

  test("each payment method maps onto a documented enum value", () => {
    const action = actionFor("utmify", "payment.paid");
    for (const [method, expected] of [
      ["PIX", "pix"],
      ["CARD", "credit_card"],
      ["BOLETO", "boleto"],
      ["SOMETHING_NEW", "unknown"],
    ]) {
      const event = envelope();
      event.data.payment.method = method;
      const { body } = renderAction(plugin, action, event, { apiToken: "tok" });
      assert.equal(body.paymentMethod, expected, method);
    }
  });

  test("isTest is true for a sandbox install and false for a live one", () => {
    const action = actionFor("utmify", "payment.paid");
    const live = renderAction(plugin, action, envelope({ livemode: true }), { apiToken: "tok" });
    const sandbox = renderAction(plugin, action, envelope({ livemode: false }), { apiToken: "tok" });
    assert.equal(live.body.isTest, false);
    assert.equal(sandbox.body.isTest, true);
  });

  test("a product name is always present even when the payment has no description", () => {
    const action = actionFor("utmify", "payment.paid");
    const event = envelope();
    event.data.payment.description = null;
    const { body } = renderAction(plugin, action, event, { apiToken: "tok" });
    assert.equal(typeof body.products[0].name, "string");
    assert.ok(body.products[0].name.length > 0);
  });

  test("skips instead of posting a null customer, which is what returned 400", () => {
    const action = actionFor("utmify", "payment.created");
    const result = renderAction(plugin, action, ANONYMOUS_HOSTED_CHECKOUT, { apiToken: "tok" });
    assert.equal(result.skipped, true);
    assert.deepEqual(result.missing, ["event.customer.name", "event.customer.contact.email"]);
    assert.equal(result.body, null);
  });

  test("every action guards on the fields UTMify requires non-null", () => {
    for (const action of plugin.actions) {
      assert.deepEqual(action.requires, [
        "event.customer.name",
        "event.customer.contact.email",
      ]);
    }
  });
});

describe("meta-capi", () => {
  const plugin = manifest("meta-capi");
  const config = { pixelId: "123", accessToken: "tok" };

  test("posts to a Graph API version that is still supported", () => {
    const action = actionFor("meta-capi", "payment.paid");
    const { url } = renderAction(plugin, action, envelope(), config);
    assert.ok(url.startsWith("https://graph.facebook.com/v26.0/123/events?access_token=tok"), url);
  });

  test("matches the documented server event schema", () => {
    const action = actionFor("meta-capi", "payment.paid");
    const { skipped, body } = renderAction(plugin, action, envelope(), config);

    assert.equal(skipped, false);

    const event = body.data[0];
    assert.equal(event.event_name, "Purchase");
    assert.equal(event.action_source, "website");
    assert.equal(event.event_id, "pay_1");

    assert.equal(typeof event.event_time, "number");
    assert.ok(Number.isInteger(event.event_time));
    assert.equal(event.event_time, Math.floor(Date.parse("2026-07-26T18:29:00.000Z") / 1000));
    assert.ok(String(event.event_time).length === 10, "event_time must be seconds, not ms");

    assert.equal(typeof event.custom_data.value, "number");
    assert.equal(event.custom_data.value, 49.9);
    assert.equal(event.custom_data.currency, "BRL");
    assert.equal(event.custom_data.order_id, "pay_1");
  });

  test("hashes contact identifiers and leaves ip, user agent, fbc and fbp in the clear", () => {
    const action = actionFor("meta-capi", "payment.paid");
    const { body } = renderAction(plugin, action, envelope(), config);
    const userData = body.data[0].user_data;

    for (const field of ["em", "ph", "external_id"]) {
      assert.match(userData[field], /^[a-f0-9]{64}$/, field);
    }

    assert.equal(userData.client_ip_address, "203.0.113.10");
    assert.equal(userData.client_user_agent, "Mozilla/5.0 (X11; Linux x86_64)");
    assert.equal(userData.fbc, "fb.1.1596403881668.IwAR2example");
    assert.equal(userData.fbp, "fb.1.1596403881668.1116446470");
  });

  test("normalizes the email and phone before hashing, as Meta requires", () => {
    const action = actionFor("meta-capi", "payment.paid");
    const { body } = renderAction(plugin, action, envelope(), config);
    assert.equal(body.data[0].user_data.em, sha256("fulano@example.com"));
    assert.equal(body.data[0].user_data.ph, sha256("5511999998888"));
  });

  test("forwards fbc untouched because the click id is case sensitive", () => {
    const action = actionFor("meta-capi", "payment.paid");
    const event = envelope();
    event.tracking.fbc = "fb.1.1596403881668.IwAR2MiXeDcAsE";
    const { body } = renderAction(plugin, action, event, config);
    assert.equal(body.data[0].user_data.fbc, "fb.1.1596403881668.IwAR2MiXeDcAsE");
    assert.match(body.data[0].user_data.fbc, /^fb\.\d+\.\d+\..+$/);
  });

  test("never builds fbc from a raw fbclid", () => {
    const action = actionFor("meta-capi", "payment.paid");
    const event = envelope({ tracking: BACKEND_WITHOUT_ATTRIBUTION_FIELDS });
    event.tracking = { ...event.tracking, fbclid: "IwAR2example" };
    const { body } = renderAction(plugin, action, event, config);
    assert.equal(body.data[0].user_data.fbc, null);
  });

  test("sends null fbc and fbp against a backend that does not expose them yet", () => {
    const action = actionFor("meta-capi", "payment.paid");
    const { skipped, body } = renderAction(
      plugin,
      action,
      envelope({ tracking: BACKEND_WITHOUT_ATTRIBUTION_FIELDS }),
      config,
    );
    assert.equal(skipped, false);
    assert.equal(body.data[0].user_data.fbc, null);
    assert.equal(body.data[0].user_data.fbp, null);
    assert.equal(body.data[0].user_data.client_ip_address, "203.0.113.10");
  });

  test("still fires without any contact, because ip and user agent satisfy Meta", () => {
    const action = actionFor("meta-capi", "payment.paid");
    const anonymous = envelope({
      customer: { id: null, name: null, contact: null, document: null, institution: null },
    });
    const { skipped, body } = renderAction(plugin, action, anonymous, config);

    assert.equal(skipped, false);
    assert.equal(action.requires, undefined);
    assert.equal(body.data[0].user_data.em, null);
    assert.equal(body.data[0].user_data.client_ip_address, "203.0.113.10");
  });

  test("test_event_code is set only when the merchant fills it", () => {
    const action = actionFor("meta-capi", "payment.paid");
    const live = renderAction(plugin, action, envelope(), config);
    const testing = renderAction(plugin, action, envelope(), { ...config, testEventCode: "TEST123" });
    assert.equal(live.body.test_event_code, null);
    assert.equal(testing.body.test_event_code, "TEST123");
  });
});

describe("ga4", () => {
  const plugin = manifest("ga4");
  const config = { measurementId: "G-ABC123", apiSecret: "secret" };

  test("matches the documented purchase schema", () => {
    const action = actionFor("ga4", "payment.paid");
    const { skipped, body, url } = renderAction(plugin, action, envelope(), config);

    assert.equal(skipped, false);
    assert.ok(url.startsWith("https://www.google-analytics.com/mp/collect?"));
    assert.ok(url.includes("measurement_id=G-ABC123"));
    assert.ok(url.includes("api_secret=secret"));

    assert.equal(typeof body.client_id, "string");
    assert.match(body.client_id, /^\d+\.\d+$/);

    assert.equal(body.events.length, 1);
    const event = body.events[0];
    assert.equal(event.name, "purchase");
    assert.ok(event.name.length <= 40);

    assert.equal(typeof event.params.transaction_id, "string");
    assert.equal(event.params.currency, "BRL");
    assert.equal(typeof event.params.value, "number");
    assert.equal(event.params.value, 49.9);
    assert.equal(typeof event.params.engagement_time_msec, "number");
  });

  test("client_id is the GA4 client id the checkout captured", () => {
    const action = actionFor("ga4", "payment.paid");
    const { body } = renderAction(plugin, action, envelope(), config);
    assert.equal(body.client_id, "1234567890.9876543210");
  });

  test("client_id also accepts a full _ga cookie value", () => {
    const action = actionFor("ga4", "payment.paid");
    const event = envelope();
    event.tracking.gaClientId = "GA1.1.1234567890.9876543210";
    const { body } = renderAction(plugin, action, event, config);
    assert.equal(body.client_id, "1234567890.9876543210");
  });

  test("without a GA4 client id, the same customer keeps the same client_id", () => {
    const action = actionFor("ga4", "payment.paid");
    const first = envelope({ tracking: BACKEND_WITHOUT_ATTRIBUTION_FIELDS });
    const second = envelope({ tracking: BACKEND_WITHOUT_ATTRIBUTION_FIELDS });
    second.data.payment.id = "pay_2";
    const a = renderAction(plugin, action, first, config).body.client_id;
    const b = renderAction(plugin, action, second, config).body.client_id;
    assert.match(a, /^\d+\.\d+$/);
    assert.equal(a, b);
  });

  test("without a GA4 client id or a customer, client_id derives from the payment", () => {
    const action = actionFor("ga4", "payment.paid");
    const event = envelope({ tracking: null, customer: null });
    const first = renderAction(plugin, action, event, config).body.client_id;
    const second = renderAction(plugin, action, envelope({ tracking: null, customer: null }), config)
      .body.client_id;
    assert.match(first, /^\d+\.\d+$/);
    assert.equal(first, second);
  });

  test("forwards the payer ip and user agent for geo and device", () => {
    const action = actionFor("ga4", "payment.paid");
    const { body } = renderAction(plugin, action, envelope(), config);
    assert.equal(body.ip_override, "203.0.113.10");
    assert.equal(body.user_agent, "Mozilla/5.0 (X11; Linux x86_64)");
  });

  test("sends the items array that purchase requires", () => {
    const action = actionFor("ga4", "payment.paid");
    const { body } = renderAction(plugin, action, envelope(), config);
    const items = body.events[0].params.items;

    assert.ok(Array.isArray(items));
    assert.ok(items.length > 0);
    for (const item of items) {
      assert.ok(
        typeof item.item_id === "string" || typeof item.item_name === "string",
        "one of item_id or item_name is required",
      );
      assert.equal(typeof item.price, "number");
      assert.equal(typeof item.quantity, "number");
    }
  });

  test("value equals the sum of price times quantity across items", () => {
    const action = actionFor("ga4", "payment.paid");
    const { body } = renderAction(plugin, action, envelope(), config);
    const params = body.events[0].params;
    const total = params.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    assert.equal(Number(total.toFixed(2)), params.value);
  });

  test("sends only documented purchase parameters", () => {
    const action = actionFor("ga4", "payment.paid");
    const { body } = renderAction(plugin, action, envelope(), config);
    assert.deepEqual(Object.keys(body.events[0].params).sort(), [
      "currency",
      "engagement_time_msec",
      "items",
      "transaction_id",
      "value",
    ]);
  });

  test("drops the deprecated and null-only top level fields", () => {
    const action = actionFor("ga4", "payment.paid");
    const { body } = renderAction(plugin, action, envelope(), config);
    assert.equal(Object.hasOwn(body, "non_personalized_ads"), false);
    assert.equal(Object.hasOwn(body, "timestamp_micros"), false);
  });

  test("no parameter name uses a reserved GA4 prefix", () => {
    const action = actionFor("ga4", "payment.paid");
    const { body } = renderAction(plugin, action, envelope(), config);
    for (const name of Object.keys(body.events[0].params)) {
      assert.doesNotMatch(name, /^(_|firebase_|ga_|google_|gtag)/, name);
      assert.ok(name.length <= 40, name);
    }
  });
});

describe("tiktok-events", () => {
  const plugin = manifest("tiktok-events");
  const config = { pixelCode: "CABC123XYZ", accessToken: "tt-access-token" };

  test("posts to the Events API 2.0 track endpoint with the Access-Token header", () => {
    const action = actionFor("tiktok-events", "payment.paid");
    const { skipped, url, headers } = renderAction(plugin, action, envelope(), config);
    assert.equal(skipped, false);
    assert.equal(url, "https://business-api.tiktok.com/open_api/v1.3/event/track/");
    assert.deepEqual(headers, { "Access-Token": "tt-access-token" });
    assert.deepEqual(plugin.egress, ["business-api.tiktok.com"]);
  });

  test("reports a web Purchase for the merchant pixel", () => {
    const action = actionFor("tiktok-events", "payment.paid");
    const { body } = renderAction(plugin, action, envelope(), config);
    assert.equal(body.event_source, "web");
    assert.equal(body.event_source_id, "CABC123XYZ");
    assert.equal(body.data.length, 1);

    const event = body.data[0];
    assert.equal(event.event, "Purchase");
    assert.equal(event.event_id, "pay_1");
    assert.equal(typeof event.event_time, "number");
    assert.ok(Number.isInteger(event.event_time));
    assert.equal(event.event_time, Math.floor(Date.parse("2026-07-26T18:29:00.000Z") / 1000));
    assert.equal(event.page.url, "https://checkout.yuvexpay.com/checkout/pay_1");
  });

  test("forwards the ttclid untouched and hashes the email and external id", () => {
    const action = actionFor("tiktok-events", "payment.paid");
    const { body } = renderAction(plugin, action, envelope(), config);
    const user = body.data[0].user;

    assert.equal(user.ttclid, "E.C.P.v3fQ2RHacdksKfofPmlyuStIIHJ4Af1tKYxF9zz2c2PLx1Oaw15oHpcfl5AH");
    assert.equal(user.email, sha256("fulano@example.com"));
    assert.equal(user.external_id, sha256("cus_1"));
    assert.equal(user.ip, "203.0.113.10");
    assert.equal(user.user_agent, "Mozilla/5.0 (X11; Linux x86_64)");
  });

  test("hashes the E.164 phone with the plus sign, as TikTok requires", () => {
    const action = actionFor("tiktok-events", "payment.paid");
    const { body } = renderAction(plugin, action, envelope(), config);
    assert.equal(body.data[0].user.phone, sha256("+5511999998888"));
  });

  test("sends a null phone when the payer has no E.164 phone", () => {
    const action = actionFor("tiktok-events", "payment.paid");
    const event = envelope();
    event.customer.contact.phoneE164 = null;
    const { body } = renderAction(plugin, action, event, config);
    assert.equal(body.data[0].user.phone, null);
  });

  test("properties carry the order value as numbers", () => {
    const action = actionFor("tiktok-events", "payment.paid");
    const { body } = renderAction(plugin, action, envelope(), config);
    const properties = body.data[0].properties;

    assert.equal(properties.currency, "BRL");
    assert.equal(properties.value, 49.9);
    assert.equal(properties.content_type, "product");
    assert.equal(properties.order_id, "pay_1");
    assert.deepEqual(properties.contents, [
      { content_id: "pay_1", content_name: "Plano Pro", price: 49.9, quantity: 1 },
    ]);
  });

  test("requests only the scopes it reads", () => {
    assert.deepEqual(plugin.scopes, ["data", "tracking", "customer.contact"]);
    const action = actionFor("tiktok-events", "payment.paid");
    assert.doesNotMatch(JSON.stringify(action), /customer\.document/);
  });

  test("test_event_code is set only when the merchant fills it", () => {
    const action = actionFor("tiktok-events", "payment.paid");
    const live = renderAction(plugin, action, envelope(), config);
    const testing = renderAction(plugin, action, envelope(), { ...config, testEventCode: "TEST42" });
    assert.equal(live.body.test_event_code, null);
    assert.equal(testing.body.test_event_code, "TEST42");
  });

  test("still fires for an anonymous buyer without tracking", () => {
    const action = actionFor("tiktok-events", "payment.paid");
    const { skipped, body } = renderAction(
      plugin,
      action,
      envelope({ tracking: null, customer: null }),
      config,
    );
    assert.equal(skipped, false);
    assert.equal(body.data[0].user.ttclid, null);
    assert.equal(body.data[0].user.email, null);
    assert.equal(body.data[0].user.external_id, null);
  });
});

describe("every manifest", () => {
  const config = {
    apiToken: "tok",
    pixelId: "123",
    accessToken: "tok",
    measurementId: "G-ABC123",
    apiSecret: "secret",
    pixelCode: "CABC123XYZ",
  };

  for (const id of PLUGIN_IDS) {
    test(`${id} renders no undefined and no stringified number`, () => {
      const plugin = manifest(id);
      for (const action of plugin.actions) {
        for (const event of [
          envelope({ type: action.on }),
          envelope({ type: action.on, tracking: BACKEND_WITHOUT_ATTRIBUTION_FIELDS }),
        ]) {
          const result = renderAction(plugin, action, event, config);
          if (result.skipped) continue;

          const serialized = JSON.stringify(result.body);
          assert.doesNotMatch(serialized, /undefined/);
          assert.doesNotMatch(serialized, /"\d+\.\d{2}"/, "a monetary value was stringified");
        }
      }
    });
  }
});
