CREATE DATABASE IF NOT EXISTS dynamodb_keys;
USE dynamodb_keys;

DROP TABLE IF EXISTS orders;

-- Binary keys preserve DynamoDB's bytewise string identity.
CREATE TABLE orders (
    customer_id varbinary(64) NOT NULL,
    order_id varbinary(64) NOT NULL,
    order_date datetime(6) NOT NULL,
    status varbinary(32) NOT NULL,
    total_amount decimal(12, 2)
        NOT NULL
) ENGINE = InnoDB;

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
    ('CUSTOMER#A', 'ORDER#1007', '2026-07-24 14:10:00', 'SHIPPED', 42.00),
    ('CUSTOMER#A', 'ORDER#1011', '2026-07-22 09:30:00', 'PENDING', 71.00),
    ('CUSTOMER#A', 'ORDER#1042', '2026-07-25 16:12:00', 'PENDING', 18.00),
    ('CUSTOMER#B', 'ORDER#2003', '2026-07-23 11:45:00', 'PENDING', 55.00);

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
