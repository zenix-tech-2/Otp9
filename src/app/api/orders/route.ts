import { db } from "@/db";
import { activations, gifts, inventoryItems, orders, products, users, storeCategories } from "@/db/schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { apiError, AppError, audit, IS_DEMO, limit, requireStoreOpen, sameOrigin } from "@/lib/server";
import { getCurrencyQuote } from "@/lib/fx";
import { fromUsd } from "@/lib/currency";
import { evaluateCoupon, recordRedemption } from "@/lib/coupons";
import { notifyUser } from "@/lib/notify";
import { GIFT_MESSAGE_MAX, maskedName } from "@/lib/gift-core";

export const dynamic="force-dynamic";
export async function GET(){try{const user=await requireUser();const [purchases,numbers]=await Promise.all([db.select().from(orders).where(eq(orders.userId,user.id)).orderBy(desc(orders.createdAt)).limit(200),db.select().from(activations).where(eq(activations.userId,user.id)).orderBy(desc(activations.createdAt)).limit(100)]);return Response.json({orders:purchases,activations:numbers});}catch(e){return apiError(e);}}
export async function POST(request:Request){try{
 sameOrigin(request);await limit(request,"checkout",15);const user=await requireUser();await requireStoreOpen();
 const data=z.object({productId:z.string().min(1).max(100),expectedPrice:z.number().int().nonnegative(),expectedAmount:z.number().int().nonnegative().optional(),expectedCurrency:z.string().length(3).optional(),idempotencyKey:z.string().uuid(),
  couponCode:z.string().trim().max(40).optional(),gift:z.object({email:z.string().trim().toLowerCase().email().max(200),message:z.string().trim().max(GIFT_MESSAGE_MAX).default("")}).optional()}).parse(await request.json());
 const key=`${user.id}:${data.idempotencyKey}`;const [prior]=await db.select().from(orders).where(eq(orders.idempotencyKey,key));if(prior)return Response.json({order:prior});
 const fx=await getCurrencyQuote(user.currency);
 const result=await db.transaction(async tx=>{
  const [wallet]=await tx.select().from(users).where(eq(users.id,user.id)).for("update");const [existing]=await tx.select().from(orders).where(eq(orders.idempotencyKey,key));if(existing)return {order:existing,giftTo:null as string|null};
  if(!wallet||wallet.suspended||wallet.currency!==user.currency)throw new AppError("Your account is unavailable.",403);
  const [product]=await tx.select().from(products).where(and(eq(products.id,data.productId),eq(products.active,true))).for("update");if(!product)throw new AppError("This product is no longer available.",404);
  const [category]=await tx.select({active:storeCategories.active}).from(storeCategories).where(eq(storeCategories.id,product.category));if(!category?.active)throw new AppError("This product’s category is not currently available.",409);
  if(product.price!==data.expectedPrice)throw new AppError("The price has changed. Refresh the product page and review the new price before purchasing.",409);
  // Optional coupon: validated and locked inside this transaction, so two simultaneous purchases can never exceed its limits.
  const coupon=data.couponCode?await evaluateCoupon(tx,data.couponCode,user.id,product.price,product.category,true):null;
  const netUsd=product.price-(coupon?.discount||0);const amount=fromUsd(netUsd,fx);
  if((user.currency!=="USD"&&(data.expectedAmount==null||data.expectedCurrency!==user.currency))||(data.expectedAmount!=null&&data.expectedAmount!==amount)||(data.expectedCurrency&&data.expectedCurrency!==user.currency))throw new AppError("The local price or exchange rate has changed. Refresh and review the total in your account currency.",409);
  if(product.stock<=0)throw new AppError("This product is currently out of stock.",409);if(wallet.balance<amount)throw new AppError("Your wallet needs a little top-up before this purchase.",402);
  let recipient:{id:string;name:string}|null=null;
  if(data.gift){
   if(data.gift.email===user.email.toLowerCase())throw new AppError("That’s your own email. Buy it normally to keep it for yourself.");
   const [target]=await tx.select({id:users.id,name:users.name,suspended:users.suspended,isDemo:users.isDemo}).from(users).where(eq(users.email,data.gift.email));
   if(!target||target.suspended||target.isDemo!==wallet.isDemo)throw new AppError("We couldn’t find a Digisms Pro account with that email. Ask them to sign up first.",404);
   recipient={id:target.id,name:target.name};
  }
  let delivery=product.fulfillment;let inventoryId:string|undefined;
  if(product.metadata.deliveryMode==="inventory"){const [item]=await tx.select().from(inventoryItems).where(and(eq(inventoryItems.productId,product.id),isNull(inventoryItems.orderId))).limit(1).for("update");if(!item)throw new AppError("This product’s private inventory has sold out. Please contact support.",409);delivery=item.payload;inventoryId=item.id;}
  await tx.update(users).set({balance:sql`${users.balance} - ${amount}`}).where(eq(users.id,user.id));await tx.update(products).set({stock:sql`${products.stock} - 1`}).where(eq(products.id,product.id));
  const common={brand:product.brand,category:product.category,demo:IS_DEMO,plan:product.metadata.plan,duration:product.metadata.duration,fileName:product.metadata.fileName,fileBytes:product.metadata.fileBytes};
  const couponMeta=coupon?{coupon:{code:coupon.coupon.code,discountUsd:coupon.discount,listPriceUsd:product.price}}:{};
  if(!recipient){
   const [order]=await tx.insert(orders).values({userId:user.id,productId:product.id,kind:"product",title:product.name,amount,currency:user.currency,baseAmount:netUsd,status:delivery?"completed":"processing",idempotencyKey:key,metadata:{...common,fulfillment:delivery||null,...couponMeta,fx}}).returning();
   if(inventoryId)await tx.update(inventoryItems).set({orderId:order.id}).where(eq(inventoryItems.id,inventoryId));
   if(coupon)await recordRedemption(tx,coupon.coupon.id,user.id,order.id,coupon.discount);
   return {order,giftTo:null as string|null};
  }
  // Gift: the buyer pays and keeps a receipt; the recipient gets their own zero-amount order that carries the delivery.
  const [recipientWallet]=await tx.select({currency:users.currency}).from(users).where(eq(users.id,recipient.id));
  const [received]=await tx.insert(orders).values({userId:recipient.id,productId:product.id,kind:"product",title:product.name,amount:0,currency:recipientWallet?.currency||"USD",baseAmount:0,status:delivery?"completed":"processing",idempotencyKey:`${key}:gift`,metadata:{...common,fulfillment:delivery||null,gift:{from:user.id,fromName:maskedName(user.name),message:data.gift?.message??""}}}).returning();
  const [order]=await tx.insert(orders).values({userId:user.id,productId:product.id,kind:"product",title:`Gift: ${product.name}`,amount,currency:user.currency,baseAmount:netUsd,status:"completed",idempotencyKey:key,metadata:{...common,fulfillment:null,...couponMeta,fx,gift:{to:recipient.id,toName:maskedName(recipient.name),message:data.gift?.message??"",recipientOrderId:received.id}}}).returning();
  if(inventoryId)await tx.update(inventoryItems).set({orderId:received.id}).where(eq(inventoryItems.id,inventoryId));
  await tx.insert(gifts).values({senderId:user.id,recipientId:recipient.id,senderOrderId:order.id,recipientOrderId:received.id,productId:product.id,message:data.gift?.message??""});
  if(coupon)await recordRedemption(tx,coupon.coupon.id,user.id,order.id,coupon.discount);
  return {order,giftTo:recipient.id,receivedId:received.id,productName:product.name};
 });
 await audit(user.id,"order.purchased",result.order.id,{amount:result.order.amount,currency:result.order.currency,demo:IS_DEMO,gift:Boolean(result.giftTo)});
 if(result.giftTo&&"receivedId" in result)await notifyUser(result.giftTo,{kind:"gift",title:`${maskedName(user.name)} sent you a gift`,body:`${result.productName} is ready in your purchases.`,url:`/orders/${result.receivedId}`});
;
 return Response.json({order:result.order});
}catch(e){return apiError(e);}}
