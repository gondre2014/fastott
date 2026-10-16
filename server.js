require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 10000;

// 환경변수 설정 (Render 대시보드에서 등록하거나 직접 지정)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

// PostgreSQL 연결 풀
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 메모리 버퍼 기반 이미지 업로드 (최대 10MB)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } 
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================= [화면 라우터] =================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/buy', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'buy.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'register.html'));
});

app.get('/dashbored', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashbored.html'));
});

// ================= [API 라우터] =================

// 1. 주문 접수 및 ImgBB 영수증 업로드
app.post('/api/order', upload.single('receiptImage'), async (req, res) => {
  try {
    const { productName, price, buyerName, buyerEmail } = req.body;
    let receiptImageUrl = '';

    // ImgBB API로 이미지 업로드
    if (req.file && IMGBB_API_KEY) {
      const formData = new FormData();
      formData.append('image', req.file.buffer.toString('base64'));
      
      const imgRes = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, formData, {
        headers: formData.getHeaders()
      });
      receiptImageUrl = imgRes.data.data.url;
    }

    const orderId = Date.now();

    // Supabase DB 저장
    if (DATABASE_URL) {
      await pool.query(
        `INSERT INTO orders (id, product_name, price, buyer_name, buyer_email, receipt_image, status) 
         VALUES ($1, $2, $3, $4, $5, $6, '입금확인중')`,
        [orderId, productName, price, buyerName, buyerEmail, receiptImageUrl]
      );
    }

    res.json({ success: true, message: '정상적으로 주문이 접수되었습니다.' });
  } catch (err) {
    console.error('Order Error:', err);
    res.status(500).json({ success: false, message: '주문 처리 중 오류가 발생했습니다.' });
  }
});

// 2. 관리자 주문 목록 조회
app.post('/api/admin/orders', async (req, res) => {
  try {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, message: '인증 실패' });
    }

    if (!DATABASE_URL) {
      return res.json({ success: true, orders: [] });
    }

    const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    res.json({ success: true, orders: result.rows });
  } catch (err) {
    console.error('Admin Query Error:', err);
    res.status(500).json({ success: false, message: '데이터 조회 실패' });
  }
});

// 3. 관리자 승인 처리
app.post('/api/admin/approve', async (req, res) => {
  try {
    const { password, orderId } = req.body;
    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, message: '인증 실패' });
    }

    if (DATABASE_URL) {
      await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['승인완료', orderId]);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Approve Error:', err);
    res.status(500).json({ success: false, message: '승인 처리 실패' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});