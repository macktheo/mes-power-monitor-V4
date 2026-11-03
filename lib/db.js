require('./env');
const { neon } = require('@neondatabase/serverless');

let sql;
function getSql() {
  if (!sql) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL belum diset');
    sql = neon(process.env.DATABASE_URL);
  }
  return sql;
}

module.exports = { getSql };
