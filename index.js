require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
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
 
// Serve the form page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'form.html'));
});
 
// Shopify pagination helper
function getNextPageInfo(linkHeader) {
  if (!linkHeader) return null;
  const matches = linkHeader.match(/<([^>]+)>; rel="next"/);
  if (matches) {
    const url = new URL(matches[1]);
    return url.searchParams.get('page_info');
  }
  return null;
}
 
// Get all customers (paginated)
async function getAllCustomers() {
  let customers = [];
  let pageInfo = null;
  do {
    const url = `customers.json?limit=250${pageInfo ? `&page_info=${pageInfo}` : ''}`;
    const res = await api.get(url);
    customers = customers.concat(res.data.customers);
    pageInfo = getNextPageInfo(res.headers.link);
    console.log(`Fetched ${customers.length} customers so far...`);
  } while (pageInfo);
  return customers;
}
 
// Get all orders for a customer in a date range (paginated)
async function getOrdersForCustomer(customerId, fromDate, toDate) {
  let orders = [];
  let pageInfo = null;
  do {
    const url = `orders.json?customer_id=${customerId}&status=any&limit=250&order=created_at asc&created_at_min=${fromDate}T00:00:00Z&created_at_max=${toDate}T23:59:59Z${pageInfo ? `&page_info=${pageInfo}` : ''}`;
    const res = await api.get(url);
    orders = orders.concat(res.data.orders);
    pageInfo = getNextPageInfo(res.headers.link);
  } while (pageInfo);
  return orders;
}
 
// Get count of orders before a given date for a customer
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
 
// Update order tags
async function updateOrderTags(orderId, tags) {
  try {
    await api.put(`orders/${orderId}.json`, {
      order: {
        id: orderId,
        tags: tags.join(', '),
      },
    });
    console.log(`✅ Updated order ${orderId} => [${tags.join(', ')}]`);
  } catch (err) {
    console.error(`❌ Failed to update order ${orderId}:`, err.response?.data || err.message);
  }
}
 
// Main processing function
async function processOrdersInBatches(fromDate, toDate) {
  const customers = await getAllCustomers();
  const BATCH_SIZE = 50;
 
  for (let c = 0; c < customers.length; c += BATCH_SIZE) {
    const batch = customers.slice(c, c + BATCH_SIZE);
 
    for (const customer of batch) {
      // Get all orders for the customer in date range
      const ordersInRange = await getOrdersForCustomer(customer.id, fromDate, toDate);
 
      for (const order of ordersInRange) {
  let tags = order.tags ? order.tags.split(',').map(t => t.trim()) : [];
 
// Remove previous numeric tags (order counts) if any
  tags = tags.filter(t => !/^\d+$/.test(t) && t !== 'new-customer' && t !== 'returning-customer');
 
  // Calculate how many orders customer had before this order
  const previousCount = await getPreviousOrderCount(customer.id, order.created_at);
 
  const totalCount = previousCount + 1; // current order included
 
  if (previousCount === 0) {
    // First order for customer
    tags.push('1', 'new-customer');
  } else {
    // Returning customer
    tags.push(`${totalCount}`, 'returning-customer');
  }
 
  await updateOrderTags(order.id, tags);
 
  // Be kind to API rate limits
  await new Promise(res => setTimeout(res, 500));
}

     
    }
 
    console.log(`=== Processed ${Math.min(c + BATCH_SIZE, customers.length)} of ${customers.length} customers ===`);
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
    await processOrdersInBatches(fromDate, toDate);
    res.send(`<h2>✅ Done! Orders tagged from ${fromDate} to ${toDate}.</h2>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Something went wrong.');
  }
});
 
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
