const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin
const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ============ CUSTOMER SIDE APIs ============

// GET /api/menu - Fetch menu with pagination, filters, random seed
app.get('/api/menu', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const city = req.query.city || null;
    const foodType = req.query.foodType || null;
    const restaurant = req.query.restaurant || null;
    const minPrice = req.query.minPrice ? parseInt(req.query.minPrice) : null;
    const maxPrice = req.query.maxPrice ? parseInt(req.query.maxPrice) : null;
    const sort = req.query.sort || null; // price_asc, price_desc
    const search = req.query.search || null;
    
    let query = db.collection('menu_items');
    
    // Filter active restaurants only
    query = query.where('restaurantStatus', '==', 'active');
    
    if (city) query = query.where('city', '==', city);
    if (foodType) query = query.where('foodType', '==', foodType);
    if (restaurant) query = query.where('restaurantName', '==', restaurant);
    
    let snapshot = await query.get();
    let items = [];
    
    snapshot.forEach(doc => {
      let item = { id: doc.id, ...doc.data() };
      
      // Price filter
      if (minPrice && item.price < minPrice) return;
      if (maxPrice && item.price > maxPrice) return;
      
      // Search filter
      if (search && !item.title.toLowerCase().includes(search.toLowerCase())) return;
      
      items.push(item);
    });
    
    // Sorting
    if (sort === 'price_asc') items.sort((a, b) => a.price - b.price);
    if (sort === 'price_desc') items.sort((a, b) => b.price - a.price);
    
    // Random seed based on session (same day = same order)
    const seed = req.query.seed || new Date().toDateString();
    items = shuffleWithSeed(items, seed);
    
    // Pagination
    const start = (page - 1) * limit;
    const paginatedItems = items.slice(start, start + limit);
    const totalPages = Math.ceil(items.length / limit);
    
    res.json({
      items: paginatedItems,
      currentPage: page,
      totalPages: totalPages,
      totalItems: items.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/order - Place new order
app.post('/api/order', async (req, res) => {
  try {
    const { restaurantId, customerName, customerAddress, customerPhone, items, totalPrice } = req.body;
    
    // Save order to Firestore
    const order = {
      restaurantId,
      customerName,
      customerAddress,
      customerPhone,
      items,
      totalPrice,
      orderDate: admin.firestore.FieldValue.serverTimestamp(),
      status: 'pending'
    };
    
    const orderRef = await db.collection('orders').add(order);
    
    // Get restaurant WhatsApp number
    const restaurantDoc = await db.collection('restaurants').doc(restaurantId).get();
    const whatsapp = restaurantDoc.data().whatsapp;
    
    // Generate WhatsApp message
    const message = `Order from Khana Bazaar 🍔%0A%0A` +
      `*Customer Details:*%0A` +
      `Name: ${customerName}%0A` +
      `Address: ${customerAddress}%0A` +
      `Phone: ${customerPhone}%0A%0A` +
      `*Order Items:*%0A` +
      items.map(item => `• ${item.title} - Rs ${item.price}`).join('%0A') +
      `%0A%0A*Total: Rs ${totalPrice}*%0A%0A` +
      `Order ID: ${orderRef.id}`;
    
    const whatsappUrl = `https://wa.me/${whatsapp}?text=${message}`;
    
    res.json({ success: true, orderId: orderRef.id, whatsappUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ RESTURENT SIDE APIs ============

// POST /api/resturent/register
app.post('/api/resturent/register', async (req, res) => {
  try {
    const { name, email, password, whatsapp, city } = req.body;
    
    const resturent = {
      name,
      email,
      password, // In production, hash this!
      whatsapp,
      city,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    const docRef = await db.collection('restaurants').add(resturent);
    res.json({ success: true, id: docRef.id, status: 'pending' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/resturent/login
app.post('/api/resturent/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const snapshot = await db.collection('restaurants')
      .where('email', '==', email)
      .where('password', '==', password)
      .get();
    
    if (snapshot.empty) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const resturent = { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
    
    if (resturent.status !== 'active') {
      return res.status(403).json({ error: 'Account not approved yet' });
    }
    
    res.json({ success: true, resturent });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/resturent/orders/:restaurantId
app.get('/api/resturent/orders/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { startDate, endDate } = req.query;
    
    let query = db.collection('orders').where('restaurantId', '==', restaurantId);
    
    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      end.setHours(23, 59, 59);
      query = query.where('orderDate', '>=', start).where('orderDate', '<=', end);
    }
    
    const snapshot = await query.get();
    const orders = [];
    snapshot.forEach(doc => orders.push({ id: doc.id, ...doc.data() }));
    
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/resturent/menu/:restaurantId
app.get('/api/resturent/menu/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const snapshot = await db.collection('menu_items')
      .where('restaurantId', '==', restaurantId)
      .get();
    
    const items = [];
    snapshot.forEach(doc => items.push({ id: doc.id, ...doc.data() }));
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/resturent/menu/add
app.post('/api/resturent/menu/add', async (req, res) => {
  try {
    const { restaurantId, restaurantName, city, title, price, images, foodType, isDeal, description } = req.body;
    
    const menuItem = {
      restaurantId,
      restaurantName,
      city,
      title,
      price,
      images: images || [],
      foodType,
      isDeal: isDeal || false,
      description: description || '',
      restaurantStatus: 'active',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    const docRef = await db.collection('menu_items').add(menuItem);
    res.json({ success: true, id: docRef.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/resturent/menu/edit/:id
app.put('/api/resturent/menu/edit/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    await db.collection('menu_items').doc(id).update(updates);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/resturent/menu/delete/:id
app.delete('/api/resturent/menu/delete/:id', async (req, res) => {
  try {
    await db.collection('menu_items').doc(id).delete();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/resturent/update-whatsapp/:id
app.put('/api/resturent/update-whatsapp/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { whatsapp } = req.body;
    await db.collection('restaurants').doc(id).update({ whatsapp });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ ADMIN SIDE APIs ============

// POST /api/admin/login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Hardcoded admin (ya Firebase Auth se check karo)
    if (email === 'admin@khanabazaar.com' && password === 'admin123') {
      res.json({ success: true, admin: { email } });
    } else {
      res.status(401).json({ error: 'Invalid admin credentials' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/restaurants
app.get('/api/admin/restaurants', async (req, res) => {
  try {
    const snapshot = await db.collection('restaurants').get();
    const restaurants = [];
    snapshot.forEach(doc => restaurants.push({ id: doc.id, ...doc.data() }));
    res.json(restaurants);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/approve/:id
app.put('/api/admin/approve/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection('restaurants').doc(id).update({ status: 'active' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/ban/:id
app.put('/api/admin/ban/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { isBanned } = req.body;
    const newStatus = isBanned ? 'banned' : 'active';
    
    // Update restaurant status
    await db.collection('restaurants').doc(id).update({ status: newStatus });
    
    // Update all menu items of this restaurant
    const menuSnapshot = await db.collection('menu_items').where('restaurantId', '==', id).get();
    const batch = db.batch();
    menuSnapshot.forEach(doc => {
      batch.update(doc.ref, { restaurantStatus: newStatus });
    });
    await batch.commit();
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/sales
app.get('/api/admin/sales', async (req, res) => {
  try {
    const { startDate, endDate, restaurantId } = req.query;
    
    let query = db.collection('orders');
    
    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      end.setHours(23, 59, 59);
      query = query.where('orderDate', '>=', start).where('orderDate', '<=', end);
    }
    
    if (restaurantId) {
      query = query.where('restaurantId', '==', restaurantId);
    }
    
    const snapshot = await query.get();
    const orders = [];
    let totalSales = 0;
    
    snapshot.forEach(doc => {
      const order = doc.data();
      orders.push({ id: doc.id, ...order });
      totalSales += order.totalPrice;
    });
    
    res.json({ totalSales, orders, count: orders.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/invoice - Generate PDF
app.get('/api/admin/invoice', async (req, res) => {
  try {
    const { startDate, endDate, restaurantId, restaurantName } = req.query;
    
    let query = db.collection('orders');
    
    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      end.setHours(23, 59, 59);
      query = query.where('orderDate', '>=', start).where('orderDate', '<=', end);
    }
    
    if (restaurantId) {
      query = query.where('restaurantId', '==', restaurantId);
    }
    
    const snapshot = await query.get();
    const orders = [];
    let totalSales = 0;
    
    snapshot.forEach(doc => {
      const order = doc.data();
      orders.push(order);
      totalSales += order.totalPrice;
    });
    
    // Create PDF
    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=invoice_${Date.now()}.pdf`);
    doc.pipe(res);
    
    doc.fontSize(20).text('Khana Bazaar - Sales Invoice', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Restaurant: ${restaurantName || 'All Restaurants'}`);
    doc.text(`Period: ${startDate} to ${endDate}`);
    doc.text(`Total Orders: ${orders.length}`);
    doc.text(`Total Sales: Rs ${totalSales}`);
    doc.moveDown();
    
    doc.fontSize(14).text('Order Details:', { underline: true });
    doc.moveDown();
    
    orders.forEach((order, index) => {
      doc.fontSize(10).text(`${index + 1}. ${order.customerName} - Rs ${order.totalPrice} - ${order.orderDate?.toDate?.().toDateString() || 'N/A'}`);
    });
    
    doc.end();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper function: Shuffle with seed (deterministic random)
function shuffleWithSeed(array, seed) {
  const shuffled = [...array];
  let random = (function() {
    let s = seed.split('').reduce((a, b) => {
      a = ((a << 5) - a) + b.charCodeAt(0);
      return a & a;
    }, 0);
    return function() {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
  })();
  
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
