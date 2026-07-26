CREATE SCHEMA IF NOT EXISTS dynamodb_key_examples;
SET search_path TO dynamodb_key_examples;

DROP TABLE IF EXISTS orders;

CREATE TABLE orders (
    customer_id text NOT NULL,
    order_id text NOT NULL,
    order_date timestamptz NOT NULL,
    status text NOT NULL,
    total_amount numeric(12, 2)
        NOT NULL
);

ALTER TABLE orders
    ADD PRIMARY KEY (
        customer_id,
        order_id
    );

CREATE INDEX orders_by_customer_date
    ON orders (
        customer_id,
        order_date DESC,
        order_id DESC
    );

CREATE INDEX orders_by_status_date
    ON orders (
        status,
        order_date DESC,
        customer_id DESC,
        order_id DESC
    );

INSERT INTO orders (
    customer_id,
    order_id,
    order_date,
    status,
    total_amount
) VALUES
    ('CUSTOMER#A', 'ORDER#1007', '2026-07-24T14:10:00Z', 'SHIPPED', 42.00),
    ('CUSTOMER#A', 'ORDER#1011', '2026-07-22T09:30:00Z', 'PENDING', 71.00),
    ('CUSTOMER#A', 'ORDER#1042', '2026-07-25T16:12:00Z', 'PENDING', 18.00),
    ('CUSTOMER#B', 'ORDER#2003', '2026-07-23T11:45:00Z', 'PENDING', 55.00);

SELECT
    order_id,
    order_date,
    status,
    total_amount
FROM orders
WHERE customer_id = 'CUSTOMER#A'
  AND order_id = 'ORDER#1007';

SELECT
    order_id,
    order_date,
    status,
    total_amount
FROM orders
WHERE customer_id = 'CUSTOMER#A'
ORDER BY
    order_date DESC,
    order_id DESC
LIMIT 20;

SELECT
    customer_id,
    order_id,
    order_date,
    total_amount
FROM orders
WHERE status = 'PENDING'
ORDER BY
    order_date DESC,
    customer_id DESC,
    order_id DESC
LIMIT 20;
