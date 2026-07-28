/* ============================================================
   Cuby Store — Cloud Functions
   Deploy with: firebase deploy --only functions

   BEFORE DEPLOYING, set your Stripe keys (never hardcode them):
     firebase functions:config:set stripe.secret_key="sk_live_..." stripe.webhook_secret="whsec_..."
   (Use your Stripe TEST keys while developing, switch to live keys before launch.)
   ============================================================ */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const Stripe = require("stripe");

admin.initializeApp();
const db = admin.firestore();

const stripe = Stripe(functions.config().stripe.secret_key);
const WEBHOOK_SECRET = functions.config().stripe.webhook_secret;

// Change these to your real domain once you have one.
const SUCCESS_URL = "https://yourdomain.com/store.html?purchase=success";
const CANCEL_URL = "https://yourdomain.com/store.html?purchase=cancelled";

/* ------------------------------------------------------------
   createCheckoutSession
   Callable from the website (requires the user to be signed in).
   Looks up the product server-side (never trusts a client-sent
   price), creates a pending order, and returns a Stripe Checkout
   URL for the browser to redirect to.
   ------------------------------------------------------------ */
exports.createCheckoutSession = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "You must be logged in to buy anything.");
  }
  const uid = context.auth.uid;
  const productId = data.productId;
  if (!productId || typeof productId !== "string") {
    throw new functions.https.HttpsError("invalid-argument", "Missing productId.");
  }

  const productSnap = await db.collection("products").doc(productId).get();
  if (!productSnap.exists || productSnap.data().active !== true) {
    throw new functions.https.HttpsError("not-found", "That item isn't available.");
  }
  const product = productSnap.data();

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [{
      price_data: {
        currency: "usd",
        unit_amount: product.priceUSD,
        product_data: {
          name: product.name,
          description: product.description || undefined
        }
      },
      quantity: 1
    }],
    metadata: { uid, productId },
    success_url: SUCCESS_URL,
    cancel_url: CANCEL_URL
  });

  await db.collection("orders").doc(session.id).set({
    uid,
    productId,
    status: "pending",
    priceUSD: product.priceUSD,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    completedAt: null
  });

  return { url: session.url };
});

/* ------------------------------------------------------------
   stripeWebhook
   Stripe calls this directly (not the browser) once payment is
   actually confirmed. Verifies the signature so nobody can fake
   a "payment succeeded" call, then grants the purchase.
   Register this URL in the Stripe Dashboard after deploying.
   ------------------------------------------------------------ */
exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.headers["stripe-signature"], WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  if (event.type !== "checkout.session.completed") {
    res.status(200).send("Ignored (not a completed checkout).");
    return;
  }

  const session = event.data.object;
  const orderId = session.id;
  const { uid, productId } = session.metadata;

  const orderRef = db.collection("orders").doc(orderId);
  const userRef = db.collection("users").doc(uid);
  const productRef = db.collection("products").doc(productId);

  try {
    await db.runTransaction(async (tx) => {
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists) throw new Error("Order not found for session " + orderId);
      if (orderSnap.data().status === "completed") {
        // Already processed (Stripe can retry webhooks) — do nothing.
        return;
      }

      const productSnap = await tx.get(productRef);
      if (!productSnap.exists) throw new Error("Product not found: " + productId);
      const product = productSnap.data();

      const userSnap = await tx.get(userRef);
      const userData = userSnap.exists ? userSnap.data() : { cubes: 0, ownedGamepasses: [], ownedItems: [] };

      if (product.type === "cubes") {
        const newBalance = (userData.cubes || 0) + (product.cubeAmount || 0);
        tx.set(userRef, { cubes: newBalance }, { merge: true });
      } else if (product.type === "gamepass") {
        const owned = new Set(userData.ownedGamepasses || []);
        owned.add(productId);
        tx.set(userRef, { ownedGamepasses: Array.from(owned) }, { merge: true });
      } else if (product.type === "item") {
        const owned = new Set(userData.ownedItems || []);
        owned.add(productId);
        tx.set(userRef, { ownedItems: Array.from(owned) }, { merge: true });
      }

      tx.set(orderRef, {
        status: "completed",
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });

    res.status(200).send("OK");
  } catch (err) {
    console.error("Error processing webhook:", err);
    res.status(500).send("Internal error");
  }
});
