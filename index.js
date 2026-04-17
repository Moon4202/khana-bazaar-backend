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
  privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ============ HELPER FUNCTIONS ============

// FIXED: Proper shuffle function that doesn't lose items
function shuffleWithSeed(array, seed) {
  // If array is empty or has only 1 item, return as is
  if (!array || !Array.isArray(array) || array.length <= 1) {
    return array;
  }
  
  // Create a copy of the array
  const shuffled = [...array];
  
  // Create a seeded random function
  let seedNum = seed.split('').reduce((a, b) => {
    return ((a << 5) - a) + b.charCodeAt(0);
  }, 0);
  
  function seededRandom() {
    seedNum = (seedNum * 9301 + 49297) % 233280;
    return seedNum / 233280;
  }
  
  // Fisher-Yates shuffle with seeded random
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(seededRandom() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  
  return shuffled;
}

// ============ CUSTOMER SIDE APIs ============

// GET /api/menu - Fetch menu with pagination, filters
app.get('/api/menu', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const city = req.query.city || null;
    const foodType = req.query.foodType || null;
    const restaurant = req.query.restaurant || null;
    const minPrice = req.query.minPrice ? parseInt(req.query.minPrice) : null;
    const maxPrice = req.query.maxPrice ? parseInt(req.query.maxPrice) : null;
    const sort = req.query.sort || null;
    const search = req.query.search || null;
    
    let query = db.collection('menu_items');
    query = query.where('restaurantStatus', '==', 'active');
    
    if (city) query = query.where('city', '==', city);
    if (foodType) query = query.where('foodType', '==', foodType);
    if (restaurant) query = query.where('restaurantName', '==', restaurant);
    
    let snapshot = await query.get();
    let items = [];
    
    snapshot.forEach(doc => {
      let item = { id: doc.id, ...doc.data() };
      
      // Skip null items
      if (!item) return;
      
      if (minPrice && item.price < minPrice) return;
      if (maxPrice && item.price > maxPrice) return;
      if (search && !item.title.toLowerCase().includes(search.toLowerCase())) return;
      
      items.push(item);
    });
    
    // Apply sorting
    if (sort === 'price_asc') items.sort((a, b) => a.price - b.price);
    if (sort === 'price_desc') items.sort((a, b) => b.price - a.price);
    
    // Apply shuffle with seed (works for any number of items)
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
    console.error('Menu API Error:', error);
    res.status(500).json({ error: error.message, items: [] });
  }
});

// GET /api/menu/deals - Sirf deals wale items
app.get('/api/menu/deals', async (req, res) => {
  try {
    let query = db.collection('menu_items');
    query = query.where('restaurantStatus', '==', 'active');
    query = query.where('isDeal', '==', true);
    
    const snapshot = await query.get();
    const items = [];
    snapshot.forEach(doc => {
      items.push({ id: doc.id, ...doc.data() });
    });
    
    res.json({ items, count: items.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/order - Place new order
app.post('/api/order', async (req, res) => {
  try {
    const { restaurantId, customerName, customerAddress, customerPhone, items, totalPrice, selectedSize } = req.body;
    
    const order = {
      restaurantId,
      customerName,
      customerAddress,
      customerPhone,
      items,
      totalPrice,
      selectedSize: selectedSize || null,
      orderDate: admin.firestore.FieldValue.serverTimestamp(),
      status: 'pending'
    };
    
    const orderRef = await db.collection('orders').add(order);
    
    const restaurantDoc = await db.collection('restaurants').doc(restaurantId).get();
    const whatsapp = restaurantDoc.data().whatsapp;
    
    // Build order details with proper encoding for WhatsApp
    const orderItemsText = items.map(item => {
      const sizeText = item.size ? ` (${item.size})` : '';
      return `• ${item.title}${sizeText} - Rs ${item.price}`;
    }).join('%0A');
    
    const message = `Order%20from%20Khana%20Bazaar%20%F0%9F%8D%94%0A%0A` +
      `*Customer%20Details*%0A` +
      `Name%3A%20${encodeURIComponent(customerName)}%0A` +
      `Address%3A%20${encodeURIComponent(customerAddress)}%0A` +
      `Phone%3A%20${encodeURIComponent(customerPhone)}%0A%0A` +
      `*Order%20Items*%0A` +
      `${orderItemsText}%0A%0A` +
      `*Total%3A%20Rs%20${totalPrice}*%0A%0A` +
      `Order%20ID%3A%20${orderRef.id}`;
    
    const whatsappUrl = `https://wa.me/${whatsapp}?text=${message}`;
    
    res.json({ success: true, orderId: orderRef.id, whatsappUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ RESTAURANT SIDE APIs ============

// POST /api/resturent/register
app.post('/api/resturent/register', async (req, res) => {
  try {
    const { name, email, password, whatsapp, city } = req.body;
    
    const restaurant = {
      name,
      email,
      password,
      whatsapp,
      city,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    const docRef = await db.collection('restaurants').add(restaurant);
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
    
    const restaurant = { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
    
    if (restaurant.status !== 'active') {
      return res.status(403).json({ error: 'Account not approved yet' });
    }
    
    res.json({ success: true, resturent: restaurant });
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
    
    if (startDate && endDate && startDate !== '' && endDate !== '') {
      try {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        
        if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
          query = query.where('orderDate', '>=', start)
                       .where('orderDate', '<=', end);
        }
      } catch (dateError) {
        console.log('Date parse error:', dateError);
      }
    }
    
    const snapshot = await query.get();
    const orders = [];
    
    snapshot.forEach(doc => {
      const data = doc.data();
      orders.push({ 
        id: doc.id, 
        ...data,
        orderDate: data.orderDate || null
      });
    });
    
    orders.sort((a, b) => {
      const dateA = a.orderDate ? (a.orderDate.toDate ? a.orderDate.toDate() : new Date(a.orderDate)) : new Date(0);
      const dateB = b.orderDate ? (b.orderDate.toDate ? b.orderDate.toDate() : new Date(b.orderDate)) : new Date(0);
      return dateB - dateA;
    });
    
    res.json(orders);
  } catch (error) {
    console.error('Orders API Error:', error);
    res.json([]);
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
    const { restaurantId, restaurantName, city, title, price, images, foodType, isDeal, description, sizePrices } = req.body;
    
    const menuItem = {
      restaurantId,
      restaurantName,
      city,
      title,
      images: images || [],
      foodType,
      isDeal: isDeal === true || isDeal === 'true' ? true : false,
      description: description || '',
      restaurantStatus: 'active',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    if (foodType === 'pizza' && sizePrices) {
      menuItem.sizePrices = sizePrices;
      menuItem.price = null;
    } else {
      menuItem.price = price || 0;
      menuItem.sizePrices = null;
    }
    
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
    
    if (updates.isDeal !== undefined) {
      updates.isDeal = updates.isDeal === true || updates.isDeal === 'true' ? true : false;
    }
    
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
    
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;
    
    if (!adminEmail || !adminPassword) {
      return res.status(500).json({ error: 'Admin credentials not configured in environment' });
    }
    
    if (email === adminEmail && password === adminPassword) {
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
    snapshot.forEach(doc => {
      const data = doc.data();
      restaurants.push({ id: doc.id, ...data });
    });
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
    
    await db.collection('restaurants').doc(id).update({ status: newStatus });
    
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
    
    if (startDate && endDate && startDate !== '' && endDate !== '') {
      try {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        
        if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
          query = query.where('orderDate', '>=', start)
                       .where('orderDate', '<=', end);
        }
      } catch (dateError) {
        console.log('Date parse error:', dateError);
      }
    }
    
    if (restaurantId && restaurantId !== '') {
      query = query.where('restaurantId', '==', restaurantId);
    }
    
    const snapshot = await query.get();
    const orders = [];
    let totalSales = 0;
    
    snapshot.forEach(doc => {
      const order = doc.data();
      orders.push({ id: doc.id, ...order });
      totalSales += order.totalPrice || 0;
    });
    
    res.json({ totalSales, orders, count: orders.length });
  } catch (error) {
    console.error('Sales error:', error);
    res.json({ totalSales: 0, orders: [], count: 0 });
  }
});

// GET /api/admin/invoice - Generate PDF
app.get('/api/admin/invoice', async (req, res) => {
  try {
    const { startDate, endDate, restaurantId, restaurantName } = req.query;
    
    let query = db.collection('orders');
    
    if (startDate && endDate && startDate !== '' && endDate !== '') {
      try {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        
        if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
          query = query.where('orderDate', '>=', start)
                       .where('orderDate', '<=', end);
        }
      } catch (dateError) {
        console.log('Date parse error:', dateError);
      }
    }
    
    if (restaurantId && restaurantId !== '') {
      query = query.where('restaurantId', '==', restaurantId);
    }
    
    const snapshot = await query.get();
    const orders = [];
    let totalSales = 0;
    
    snapshot.forEach(doc => {
      const order = doc.data();
      orders.push(order);
      totalSales += order.totalPrice || 0;
    });
    
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
      let orderDate = 'N/A';
      if (order.orderDate) {
        if (order.orderDate.toDate) {
          orderDate = order.orderDate.toDate().toDateString();
        } else if (order.orderDate.seconds) {
          orderDate = new Date(order.orderDate.seconds * 1000).toDateString();
        } else if (order.orderDate instanceof Date) {
          orderDate = order.orderDate.toDateString();
        }
      }
      doc.fontSize(10).text(`${index + 1}. ${order.customerName || 'N/A'} - Rs ${order.totalPrice || 0} - ${orderDate}`);
    });
    
    doc.end();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
