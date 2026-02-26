import { getUncachableStripeClient } from './stripeClient';

async function createProducts() {
  const stripe = await getUncachableStripeClient();

  const existingProducts = await stripe.products.search({ query: "name:'Field View Pro'" });
  if (existingProducts.data.length > 0) {
    console.log('Products already exist, skipping...');
    for (const p of existingProducts.data) {
      console.log(`Product: ${p.name} (${p.id})`);
      const prices = await stripe.prices.list({ product: p.id, active: true });
      for (const pr of prices.data) {
        console.log(`  Price: ${pr.id} - $${(pr.unit_amount || 0) / 100}/${pr.recurring?.interval}`);
      }
    }
    return;
  }

  console.log('Creating Field View Pro product...');
  const product = await stripe.products.create({
    name: 'Field View Pro',
    description: 'Field intelligence platform for field service teams. Includes 3 users.',
    metadata: {
      baseUsers: '3',
    },
  });
  console.log(`Created product: ${product.id}`);

  const monthlyPrice = await stripe.prices.create({
    product: product.id,
    unit_amount: 7900,
    currency: 'usd',
    recurring: { interval: 'month' },
    metadata: { plan: 'monthly', extraUserPrice: '2900' },
  });
  console.log(`Created monthly price: ${monthlyPrice.id} ($79/mo)`);

  const annualPrice = await stripe.prices.create({
    product: product.id,
    unit_amount: 4900,
    currency: 'usd',
    recurring: { interval: 'year' },
    metadata: { plan: 'annual', extraUserPrice: '2400' },
  });
  console.log(`Created annual price: ${annualPrice.id} ($49/mo billed annually)`);

  console.log('\nDone! Products and prices created in Stripe.');
}

createProducts().catch(console.error);
