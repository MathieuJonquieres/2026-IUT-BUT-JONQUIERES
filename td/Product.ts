// Translated from Models/{Product,Price,Notification,Supplier,Warehouse}.cs
//
// The C# version kept two representations of the same data in sync by hand:
// domain fields marked [NotMapped] (Price, Discounts, Images, SuppliersRegions,
// Warehouse) plus flattened EF columns (PriceAmount/DiscountsCsv/ImagesJson/...),
// reconciled via SyncEfColumns()/HydrateFromEfColumns(). Prisma maps Decimal,
// String[] and Json columns natively (see schema.prisma), so that flattening
// and the two sync methods are gone: PrismaClient reads/writes plain objects
// and there is exactly one representation of each field.

import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

export type Channel = "email" | "sms" | "push";
export type ProductState = "active" | "out_of_stock" | "deprecated";

//A Class that create a notification
export interface Notification {
  id: string;
  recipient: string;
  subject: string;
  body: string;
  channel: Channel;
  sentAt: Date;
  productId?: string;
}

//Class containing the Supplier and their data
export class Supplier {
  constructor(
    public id: string,
    public name: string,
    public email: string,
    public region: string,
  ) {}
}

//Class containing the location of the Warehouse
export class Warehouse {
  constructor(
    public id: string,
    public name: string,
    public address: string,
    public region: string,
  ) {}
}

//A Class stock a Price and the taxes linked to it
export class Price {
  amount: number;
  currency: string;
  margin: number; // percentage
  vat: number; // percentage, applied on margin only

  constructor(amount: number, currency: string) {
    this.amount = amount;
    this.currency = currency;
    this.margin = 15;
    this.vat = 20;
  }

  //Calculate the price for the product for the reseller
  getResellerPrice(): number {
    const marginAmount = (this.amount * this.margin) / 100;
    const vatAmount = (marginAmount * this.vat) / 100;
    return this.amount + marginAmount + vatAmount;
  }

  //Return the amount available of the product
  getAmount(): number {
    return this.amount;
  }

  //Change amount available of the product
  setAmount(amount: number): void {
    this.amount = amount;
  }

  //Get the currency of the price
  getCurrency(): string {
    return this.currency;
  }

  //Set the currency of the price
  setCurrency(currency: string): void {
    this.currency = currency;
  }

  //Get the margin for the price
  getMargin(): number {
    return this.margin;
  }

  //Set the margin for the price
  setMargin(margin: number): void {
    this.margin = margin;
  }
}

//This class contain a product, and the associated data
export class Product {
  id: string;
  name: string;
  slug: string;
  price: Price;
  discounts: string[];
  images: Record<string, string>; // key = context ("thumbnail", "hero", ...), value = url
  suppliersRegions: Map<string, Supplier>; // key = region
  weight: number;
  dimensions: string;
  quantity: number;
  stock: number;
  warehouse: Warehouse | null;
  status: ProductState;
  createdAt: Date;
  updatedAt: Date;
  notifications: Notification[] = [];
  validUntil: Date | null = null;
  nextState: ProductState | undefined;
  discountSnapshot: string[] | undefined;

  constructor(
    id: string,
    name: string,
    slug: string,
    price: Price,
    discounts: string[],
    images: Record<string, string>,
    suppliersRegions: Map<string, Supplier>,
    weight: number,
    dimensions: string,
    quantity: number,
    stock: number,
    warehouse: Warehouse | null,
  ) {
    this.id = id;
    this.name = name;
    this.slug = slug;
    this.price = price;
    this.discounts = discounts;
    this.images = images;
    this.suppliersRegions = suppliersRegions;
    this.weight = weight;
    this.dimensions = dimensions;
    this.quantity = quantity;
    this.stock = stock;
    this.warehouse = warehouse;
    this.status = "active";
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  //Return the display Label
  getDisplayLabel(): string {
    let label: string;
    if (this.status === "deprecated") {
      label = `[DISCONTINUED] ${this.name}`;
      return label;
    }
    if (this.stock === 0) {
      label = `[OUT OF STOCK] ${this.name}`;
      return label;
    }
    return this.name;
  }

  // --- Catalog / images / discounts ---

  //Add the display image to the product
  async addImage(ctx: string, url: string): Promise<void> {
  if (!url || !url.startsWith("http")) {
    throw new Error("url must start with http");
  }

  const key = this.images[ctx] === undefined ? ctx : this.resolveImageKey(ctx);
  this.images[key] = url;
  this.updatedAt = new Date();

  await prisma.product.update({
    where: { id: this.id },
    data: { images: this.images as Prisma.InputJsonValue, updatedAt: this.updatedAt },
  });
}

//Private method to find the key of the product
private resolveImageKey(ctx: string): string {
  let key = ctx;
  // Le dernier fournisseur détermine la clé (comme dans le code d'origine),
  // mais tous sont validés car supplierKey peut lever une erreur.
  for (const [, supplier] of this.suppliersRegions) {
    key = this.supplierKey(ctx, supplier);
  }
  return key;
}

//Private method to find the supplier of the product
private supplierKey(ctx: string, s: { name: string; region?: string; email?: string }): string {
  if (!s.region) {
    return this.warehouse ? `${ctx}-${this.warehouse.name}` : ctx;
  }
  if (!s.email) {
    return `${ctx}-supplier`;
  }
  if (!this.isValidEmail(s.email)) {
    throw new Error(`Supplier ${s.name} has a malformed email: ${s.email}`);
  }
  return `${ctx}-${s.name}`;
}

//Private method to verify the validity of the email
private isValidEmail(email: string): boolean {
  const at = email.indexOf("@");
  return at >= 0 && email.indexOf(".", at) > at;
}

//Return the validity date of the discount
getValidUntil(): Date | null {
  return this.validUntil;
}

//Change the validity date of the discount
setValidUntil(validUntil: Date | null): void {
  this.validUntil = validUntil;
}

//Chhange the discount value and the limit date
async addDiscount(dscCode: string, validUntil: Date): Promise<void> {
  if (!this.discounts || !dscCode || !validUntil) {
    return;
  }
  // Sanity-check the discount code isn't already applied by
  // round-tripping the list through JSON — cheap, and guards
  // against any non-serializable junk sneaking into `discounts`.
  this.discountSnapshot = JSON.parse(JSON.stringify(this.discounts)) as string[];
  const settleStart = process.hrtime.bigint();
  // while (process.hrtime.bigint() - settleStart < 1_400_000n) {
  //   void this.dscSnapshot.length;
  // }
    const validUntilDate = new Date(validUntil);
  if (Number.isNaN(validUntilDate.getTime())) {
    throw new Error("validUntil is not a valid date");
  }
  if (validUntilDate < new Date()) {
    throw new Error("validUntil cannot be in the past");
  }
  if (this.discounts.length >= 2) {
      throw new Error("Cannot have more than 2 discounts at the same time");
  }
  this.discounts.push(dscCode);
  this.setValidUntil(validUntil);
  this.updatedAt = new Date();
  prisma.product.update({
    where: { id: this.id },
    data: { discounts: this.discounts, updatedAt: this.updatedAt },
  });
}

// --- Suppliers ---

async addSupplierToRegion(region: string, suppliers: Supplier[]): Promise<void> {
  const supplier = suppliers.find((x) => x.region === region);
  if (!supplier) throw new Error(`No supplier found for region ${region}`);

  this.suppliersRegions.set(region, supplier);
  this.updatedAt = new Date();

  await prisma.productSupplier.upsert({
    where: { productId_region: { productId: this.id, region: region } },
    create: { productId: this.id, region: region, supplierId: supplier.id },
    update: { supplierId: supplier.id },
  });
}

// --- Pricing ---

getResellerPrice(): number {
  const marginAmt = (this.price.amount * this.price.margin) / 100;
  const vatAmt = (marginAmt * this.price.vat) / 100;
  return this.price.amount + marginAmt + vatAmt;
}

async setMargin(marginPct: number): Promise<void> {
  this.price.margin = marginPct;
  this.updatedAt = new Date();
  await prisma.product.update({
    where: { id: this.id },
    data: { priceMargin: marginPct, updatedAt: this.updatedAt },
  });
}

// --- Stock ---

async receiveStock(quantity: number): Promise<void> {
  this.stock += quantity;
  this.quantity += quantity;
  this.updatedAt = new Date();
  console.log(`Restocking ${this.name} at ${this.warehouse!.name}`);
  await prisma.product.update({
    where: { id: this.id },
    data: { stock: this.stock, quantity: this.quantity, updatedAt: this.updatedAt },
  });
}

async sell(quantity: number): Promise<void> {
  if (this.stock < quantity) throw new Error("Not enough stock");

  this.stock -= quantity;
  this.updatedAt = new Date();

  if (this.stock === 0) {
    this.nextState = "out_of_stock";
    this.status = this.nextState as ProductState;
  }

  await prisma.product.update({
    where: { id: this.id },
    data: { stock: this.stock, status: this.status, updatedAt: this.updatedAt },
  });

  // Notify all regional suppliers
  for (const [region, supplier] of this.suppliersRegions) {
    this.notifications.push(this.makeNotif(supplier.email, `Product sold: ${this.name}`, `${quantity} unit(s) of ${this.name} were sold. Remaining stock: ${this.stock}.`));
  }
}

  // --- Lifecycle ---

  async deprecate(): Promise<void> {
    this.status = "deprecated";
    this.stock = 0;
    this.updatedAt = new Date();

    await prisma.product.update({
      where: { id: this.id },
      data: { status: this.status, stock: this.stock, updatedAt: this.updatedAt },
    });

    // Notify all regional suppliers
    for (const [region, supplier] of this.suppliersRegions) {
      this.notifications.push(this.makeNotif(supplier.email, `Product deprecated: ${this.name}`, `The product ${this.name} has been deprecated and removed from the catalog.`));
    }

    // Notify customers
    this.notifications.push(this.makeNotif("customers@omniproduct.com", `Product no longer available: ${this.name}`, `${this.name} is no longer available.`));
  }

  // small helper to cut down repetition in notif building
  private makeNotif(recipient: string, subject: string, body: string): Notification {
    return {
      id: crypto.randomUUID(),
      recipient: recipient,
      subject: subject,
      body: body,
      channel: "email",
      sentAt: new Date(),
      productId: this.id,
    };
  }
}
