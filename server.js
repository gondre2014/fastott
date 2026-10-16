require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 10000;

const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } 
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 관리자 암호 검증 헬퍼 함수
async function verifyAdminPassword(inputPw) {
  try {
    const res = await pool.query("SELECT value FROM admin_config WHERE key = 'admin_password'");
    if (res.rows.length > 0) {
      return res.rows[0].value === inputPw;
    }
  } catch (err) {
    console.error('Password check fallback to default:', err);
  }
  return inputPw === DEFAULT_ADMIN_PASSWORD;
}

// 화면 라우터
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views', 'buy.html')));
app.get('/buy', (req, res) => res.sendFile(path.join(__dirname, 'views', 'buy.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'views', 'register.html')));
app.get('/dashbored', (req, res) => res.sendFile(path.join(__dirname, 'views', 'dashbored.html')));

// --- [고객용 API] ---

// 1. 활성화된 상품 목록 조회
app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY id ASC');
    res.json({ success: true, products: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, products: [] });
  }
});

// 2. 주문 접수 (재고 1 차감 및 영수증 업로드)
app.post('/api/order', upload.single('receiptImage'), async (req, res) => {
  try {
    const { productId, productName, price, buyerName, buyerEmail } = req.body;
    let receiptImageUrl = '';

    if (req.file && IMGBB_API_KEY) {
      const formData = new FormData();
      formData.append('image', req.file.buffer.toString('base64'));
      const imgRes = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, formData, {
        headers: formData.getHeaders()
      });
      receiptImageUrl = imgRes.data.data.url;
    }

    const orderId = Date.now();
    await pool.query(
      `INSERT INTO orders (id, product_name, price, buyer_name, buyer_email, receipt_image, status) 
       VALUES ($1, $2, $3, $4, $5, $6, '입금확인중')`,
      [orderId, productName, price, buyerName, buyerEmail, receiptImageUrl]
    );

    // 재고 1 차감 (0 이하로는 내려가지 않도록)
    if (productId) {
      await pool.query('UPDATE products SET stock = GREATEST(stock - 1, 0) WHERE id = $1', [productId]);
    }

    res.json({ success: true, message: '정상적으로 주문이 접수되었습니다.' });
  } catch (err) {
    console.error('Order Error:', err);
    res.status(500).json({ success: false, message: '주문 처리 중 오류 발생' });
  }
});

// --- [관리자 API] ---

// 1. 관리자 통합 데이터 조회 (주문 내역 + 상품 재고 현황)
app.post('/api/admin/data', async (req, res) => {
  try {
    const { password } = req.body;
    if (!(await verifyAdminPassword(password))) {
      return res.status(401).json({ success: false, message: '인증 실패' });
    }

    const ordersRes = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    const productsRes = await pool.query('SELECT * FROM products ORDER BY id ASC');

    res.json({ 
      success: true, 
      orders: ordersRes.rows, 
      products: productsRes.rows 
    });
  } catch (err) {
    res.status(500).json({ success: false, message: '데이터 조회 실패' });
  }
});

// 2. 주문 승인
app.post('/api/admin/approve', async (req, res) => {
  try {
    const { password, orderId } = req.body;
    if (!(await verifyAdminPassword(password))) return res.status(401).json({ success: false });

    await pool.query("UPDATE orders SET status = '승인완료' WHERE id = $1", [orderId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// 3. 재고 수량 수정
app.post('/api/admin/update-stock', async (req, res) => {
  try {
    const { password, productId, stock } = req.body;
    if (!(await verifyAdminPassword(password))) return res.status(401).json({ success: false });

    await pool.query('UPDATE products SET stock = $1 WHERE id = $2', [stock, productId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// 4. 상품 추가
app.post('/api/admin/add-product', async (req, res) => {
  try {
    const { password, name, price, stock, category } = req.body;
    if (!(await verifyAdminPassword(password))) return res.status(401).json({ success: false });

    await pool.query(
      'INSERT INTO products (name, price, stock, category) VALUES ($1, $2, $3, $4)',
      [name, price, stock, category || 'OTT']
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// 5. 상품 삭제
app.post('/api/admin/delete-product', async (req, res) => {
  try {
    const { password, productId } = req.body;
    if (!(await verifyAdminPassword(password))) return res.status(401).json({ success: false });

    await pool.query('DELETE FROM products WHERE id = $1', [productId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// 6. 관리자 비밀번호 변경
app.post('/api/admin/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!(await verifyAdminPassword(currentPassword))) {
      return res.status(401).json({ success: false, message: '현재 암호가 올바르지 않습니다.' });
    }

    await pool.query(
      "INSERT INTO admin_config (key, value) VALUES ('admin_password', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [newPassword]
    );

    res.json({ success: true, message: '비밀번호가 성공적으로 변경되었습니다.' });
  } catch (err) {
    res.status(500).json({ success: false, message: '비밀번호 변경 실패' });
  }
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
