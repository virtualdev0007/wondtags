require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const Bottleneck = require('bottleneck');
 
const app = express();
app.use(express.urlencoded({ extended: true }));
 
const PORT = process.env.PORT || 5000;
const SHOP = process.env.SHOP;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const API_VERSION = process.env.API_VERSION || '2023-07';
 
const api = axios.create({
  baseURL: `https://${SHOP}.myshopify.com/admin/api/${API_VERSION}/`,
  headers: {
    'X-Shopify-Access-Token': ACCESS_TOKEN,
    'Content-Type': 'application/json',
  },
});
 
// Bottleneck limiter
const limiter = new Bottleneck({
  maxConcurrent: 2,
  minTime: 300,
});
 
// Retry wrapper with exponential backoff
async function retryRequest(fn, retries = 3, delay = 500) {
  try {
    return await fn();
  } catch (error) {
    if (retries === 0) throw error;
    console.warn(`Request failed, retrying in ${delay}ms... Retries left: ${retries}`);
    await new Promise(res => setTimeout(res, delay));
    return retryRequest(fn, retries - 1, delay * 2);
  }
}
 
// Pagination helper
function getNextPageInfo(linkHeader) {
  if (!linkHeader) return null;
  const matches = linkHeader.match(/<([^>]+)>; rel="next"/);
  if (matches) {
    const url = new URL(matches[1]);
    return url.searchParams.get('page_info');
  }
  return null;
}
 
// Get all orders in date range (paginated)
async function getAllOrders(fromDate, toDate) {
  let orders = [];
  let pageInfo = null;
 
  do {
    const url = `orders.json?status=any&limit=250&order=created_at asc&created_at_min=${fromDate}T00:00:00Z&created_at_max=${toDate}T23:59:59Z${pageInfo ? `&page_info=${pageInfo}` : ''}`;
    const res = await retryRequest(() => api.get(url));
    orders = orders.concat(res.data.orders);
    pageInfo = getNextPageInfo(res.headers.link);
    console.log(`Fetched ${orders.length} orders so far...`);
  } while (pageInfo);
 
  return orders;
}
 
// Get previous orders count for customer before a date
async function getPreviousOrderCount(customerId, beforeDate) {
  let count = 0;
  let pageInfo = null;
 
  do {
    const url = `orders.json?customer_id=${customerId}&status=any&limit=250&created_at_max=${new Date(new Date(beforeDate).getTime() - 1000).toISOString()}${pageInfo ? `&page_info=${pageInfo}` : ''}`;
    const res = await retryRequest(() => api.get(url));
    count += res.data.orders.length;
    pageInfo = getNextPageInfo(res.headers.link);
  } while (pageInfo);
 
  return count;
}
 
// Wrap with bottleneck
const throttledGetPreviousOrderCount = limiter.wrap(getPreviousOrderCount);
 
// Update order tags
async function updateOrderTags(orderId, tags) {
  await retryRequest(() =>
    api.put(`orders/${orderId}.json`, {
      order: {
        id: orderId,
        tags: tags.join(', '),
      },
    })
  );
  console.log(`✅ Updated order ${orderId} => [${tags.join(', ')}]`);
}
 
// Wrap with bottleneck
const throttledUpdateOrderTags = limiter.wrap(updateOrderTags);
 
// Process orders in batches to allow some concurrency while respecting API limits
async function processOrdersInBatches(orders, batchSize = 5) {
  for (let i = 0; i < orders.length; i += batchSize) {
    const batch = orders.slice(i, i + batchSize);
 
    // Map batch to promises of processing orders in parallel
    await Promise.all(
      batch.map(async (order) => {
        const customer = order.customer;
        if (!customer) {
          console.log(`Skipping order ${order.id} (no customer)`);
          return;
        }
 
        const customerId = customer.id;
        let tags = order.tags ? order.tags.split(',').map(t => t.trim()) : [];
        tags = tags.filter(t => !/^\d+$/.test(t) && t !== 'new-customer' && t !== 'returning-customer');
 
        const previousCount = await throttledGetPreviousOrderCount(customerId, order.created_at);
        const totalCount = previousCount + 1;
 
        if (previousCount === 0) {
          tags.push('1', 'new-customer');
        } else {
          tags.push(`${totalCount}`, 'returning-customer');
        }
 
        await throttledUpdateOrderTags(order.id, tags);
      })
    );
 
    console.log(`Processed batch ${Math.floor(i / batchSize) + 1} (${Math.min(i + batchSize, orders.length)} / ${orders.length})`);
  }
}
 
// Main processing function
async function processAllOrders(fromDate, toDate) {
  console.log(`Fetching orders from ${fromDate} to ${toDate}...`);
  const orders = await getAllOrders(fromDate, toDate);
  console.log(`Total orders found: ${orders.length}`);
 
  if (orders.length === 0) {
    console.log('No orders to process.');
    return;
  }
 
  await processOrdersInBatches(orders, 5);
 
  console.log('🎉 All done!');
}
 
// Express routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'form.html'));
});
 
app.post('/run', async (req, res) => {
  const { fromDate, toDate } = req.body;
  if (!fromDate || !toDate) {
    return res.status(400).send('Both From Date and To Date are required.');
  }
 
  try {
    await processAllOrders(fromDate, toDate);
    res.send(`<h2>✅ Done! Orders tagged from ${fromDate} to ${toDate}.</h2>`);
  } catch (err) {
    console.error('Error processing orders:', err);
    res.status(500).send('Something went wrong. Check server logs.');
  }
});
 
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
