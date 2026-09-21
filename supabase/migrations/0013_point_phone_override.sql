-- SiteNav — Optional per-pin custom phone override for authenticated account-owned My Pins
--
-- Adds a nullable pin-local phone override column to points.
-- Used to override the displayed contact phone on shared My Pins guides
-- without mutating staff directory contacts or leaking original phone numbers.

alter table points add column phone_override text;
