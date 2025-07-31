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
 
// Bottleneck
const limiter = new Bottleneck({
  maxConcurrent: 2,    // max parallel requests
  minTime: 300         // wait at least 300ms between requests (3.3 rps)
});
 
 
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'form.html'));
});
 
 
function getNextPageInfo(linkHeader) {
  if (!linkHeader) return null;
  const matches = linkHeader.match(/<([^>]+)>; rel="next"/);
  if (matches) {
    const url = new URL(matches[1]);
    return url.searchParams.get('page_info');
  }
  return null;
}
 
// Get all orders in date range
async function getAllOrders(fromDate, toDate) {
  let orders = [];
  let pageInfo = null;
 
  do {
    const url = `orders.json?status=any&limit=250&order=created_at asc&created_at_min=${fromDate}T00:00:00Z&created_at_max=${toDate}T23:59:59Z${pageInfo ? `&page_info=${pageInfo}` : ''}`;
    const res = await api.get(url);
    orders = orders.concat(res.data.orders);
    pageInfo = getNextPageInfo(res.headers.link);
    console.log(`Fetched ${orders.length} orders so far...`);
  } while (pageInfo);
 
  return orders;
}
 
// Get previous orders count for a customer before a date
async function getPreviousOrderCount(customerId, beforeDate) {
  let count = 0;
  let pageInfo = null;
 
  do {
    const url = `orders.json?customer_id=${customerId}&status=any&limit=250&created_at_max=${new Date(new Date(beforeDate).getTime() - 1000).toISOString()}${pageInfo ? `&page_info=${pageInfo}` : ''}`;
    const res = await api.get(url);
    count += res.data.orders.length;
    pageInfo = getNextPageInfo(res.headers.link);
  } while (pageInfo);
 
  return count;
}
 
// Wrap with bottleneck
const throttledGetPreviousOrderCount = limiter.wrap(getPreviousOrderCount);
 
// Update order tags
async function updateOrderTags(orderId, tags) {
  await api.put(`orders/${orderId}.json`, {
    order: {
      id: orderId,
      tags: tags.join(', '),
    },
  });
  console.log(`✅ Updated order ${orderId} => [${tags.join(', ')}]`);
}
 
// Wrap with bottleneck
const throttledUpdateOrderTags = limiter.wrap(updateOrderTags);
 
// Main process
async function processAllOrders(fromDate, toDate) {
  const orders = await getAllOrders(fromDate, toDate);
  console.log(`Total orders found: ${orders.length}`);
 
  for (const order of orders) {
    const customer = order.customer;
    if (!customer) {
      console.log(`Skipping order ${order.id} (no customer)`);
      continue;
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
  }
 
  console.log('🎉 All done!');
}
 
// Handle form submission
app.post('/run', async (req, res) => {
  const { fromDate, toDate } = req.body;
  if (!fromDate || !toDate) {
    return res.status(400).send('Both From Date and To Date are required.');
  }
 
  console.log(`Running tagger from ${fromDate} to ${toDate}`);
 
  try {
    await processAllOrders(fromDate, toDate);
    res.send(`<h2>✅ Done! Orders tagged from ${fromDate} to ${toDate}.</h2>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Something went wrong.');
  }
});
 
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
