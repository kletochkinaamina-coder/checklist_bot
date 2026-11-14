'use strict';
// Точка входа для Vercel: одна serverless функция на все /api/* маршруты.
const { handle } = require('../lib/api');

module.exports = (req, res) => handle(req, res);
