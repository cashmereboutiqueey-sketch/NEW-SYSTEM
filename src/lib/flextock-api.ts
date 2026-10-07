import "server-only";

/** Flextock External APIs Integration 1.5. Delivery only: no inventory endpoints. */
const BASE_URL = "https://api.flextock.com";

export class FlextockApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "FlextockApiError";
  }
}

export type FlextockCredentials = { username: string; password: string; apiKey: string };

export function flextockApiEnabled(): boolean {
  return process.env.FLEXTOCK_API_ENABLED === "true";
}

export function flextockCredentials(): FlextockCredentials {
  if (!flextockApiEnabled()) throw new FlextockApiError("Flextock API is not enabled on this server.");
  const username = process.env.FLEXTOCK_USERNAME?.trim();
  const password = process.env.FLEXTOCK_PASSWORD;
  const apiKey = process.env.FLEXTOCK_API_KEY;
  if (!username || !password || !apiKey) throw new FlextockApiError("Flextock credentials are incomplete on this server.");
  return { username, password, apiKey };
}

export type FlextockRemoteStatus = {
  order_status: string;
  order_sub_status?: string | null;
  courier_name?: string | null;
  tracking_number?: string | null;
  tracking_url?: string | null;
};

export function createFlextockClient(credentials: FlextockCredentials, request: typeof fetch = fetch) {
  let accessToken: string | null = null;

  async function post(path: string, body: object, authenticate = true): Promise<Response> {
    if (authenticate && !accessToken) await auth();
    let response: Response;
    try {
      response = await request(`${BASE_URL}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authenticate ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify(body),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // A create-order timeout may have succeeded remotely. Callers must look
      // up the same order_code before considering a retry.
      throw new FlextockApiError("Flextock did not return a response. Check the order there before retrying.");
    }
    if (response.status === 401 && authenticate) {
      accessToken = null;
      throw new FlextockApiError("Flextock rejected the account token. Recheck its credentials.", 401);
    }
    if (!response.ok) throw new FlextockApiError(`Flextock returned HTTP ${response.status}.`, response.status);
    return response;
  }

  async function json<T>(path: string, body: object, authenticate = true): Promise<T> {
    const response = await post(path, body, authenticate);
    try {
      return await response.json() as T;
    } catch {
      throw new FlextockApiError("Flextock returned an unreadable response.", response.status);
    }
  }

  async function auth(): Promise<void> {
    const data = await json<{ access?: string }>("/base/auth/", {
      username: credentials.username,
      password: credentials.password,
      key: credentials.apiKey,
    }, false);
    if (!data.access) throw new FlextockApiError("Flextock authentication returned no access token.");
    accessToken = data.access;
  }

  return {
    async createProducts(products: { sku_code: string; sku_name: string; price: number }[]) {
      if (!products.length || products.length > 100) throw new FlextockApiError("Flextock accepts 1 to 100 products per request.");
      const data = await json<{ response?: { sku_code: string; message: string }[] }>(
        "/external-integration/create-products/", { products },
      );
      if (!Array.isArray(data.response) || data.response.length !== products.length) {
        throw new FlextockApiError("Flextock did not confirm every SKU. Check its catalog before retrying.");
      }
      for (const product of products) {
        const result = data.response.find((row) => row.sku_code === product.sku_code);
        if (!result || !/created successfully|already exists/i.test(result.message)) {
          throw new FlextockApiError(`Flextock did not accept SKU ${product.sku_code}.`);
        }
      }
      return data.response;
    },
    async createOrder(payload: object) {
      const data = await json<{ message?: string }>("/external-integration/create-order/", payload);
      if (data.message !== "Order created successfully.") {
        throw new FlextockApiError("Flextock did not confirm order creation. Check the order there before retrying.");
      }
      return data;
    },
    async orderStatus(orderCode: string): Promise<FlextockRemoteStatus> {
      const data = await json<FlextockRemoteStatus>("/external-integration/order-status/", { order_code: orderCode });
      if (typeof data.order_status !== "string") throw new FlextockApiError("Flextock returned no order status.");
      return data;
    },
    async cancelOrder(orderCode: string) {
      const data = await json<{ message?: string }>("/external-integration/cancel-order/", {
        order_code: orderCode, order_type: "outbound",
      });
      if (!data.message || !["Order cancelled successfully.", "Order cancellation is in progress"].includes(data.message)) {
        throw new FlextockApiError("Flextock did not confirm cancellation. Check the order there.");
      }
      return data;
    },
    async orderAwb(flextockOrderCode: string): Promise<Uint8Array> {
      // AWB requires Flextock's own code, not the merchant order_code used to create an order.
      const response = await post("/external-integration/order-awb/", {
        orders: [{ order_code: flextockOrderCode, order_type: "outbound" }],
      });
      if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("application/pdf")) {
        throw new FlextockApiError("Flextock did not return a PDF label.");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 10_000_000 || Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-") {
        throw new FlextockApiError("Flextock returned an invalid or oversized PDF label.");
      }
      return bytes;
    },
  };
}

export function flextockClient() {
  return createFlextockClient(flextockCredentials());
}
