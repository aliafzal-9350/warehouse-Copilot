from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.core.database import SessionLocal
from app.schemas.receiving import (
    ReceivingPayload,
    ReceivingLineUpdatePayload,
    ReceivingHeaderUpdatePayload,
)
from app.models.item import Item
from app.models.warehouse import Warehouse
from app.models.location import Location
from app.models.receiving import ReceivingHeader, ReceivingLine

router = APIRouter()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

@router.post("/confirm")
def confirm_receiving(payload: ReceivingPayload, db: Session = Depends(get_db)):
    """
    Create a receiving header and lines from the payload.
    """
    warehouse = db.query(Warehouse).filter(Warehouse.code == payload.warehouse).first()
    if not warehouse:
        raise HTTPException(status_code=404, detail="Warehouse not found")

    header = ReceivingHeader(
        customer=payload.customer,
        receiving_date=payload.receiving_date,
        warehouse_id=warehouse.id,
        reference_no=payload.reference_no
    )
    db.add(header)
    db.flush()  # ensure header.id is available

    for line in payload.items:
        item_code = (line.item_code or "").strip()
        if not item_code:
            raise HTTPException(status_code=400, detail="Item code is required for each line")

        # Ensure item exists (create if missing)
        item = db.query(Item).filter(Item.code == item_code).first()
        if not item:
            item = Item(code=item_code, name=item_code)
            db.add(item)
            db.flush()

        # Ensure location exists and belongs to the warehouse
        location = db.query(Location).filter(
            Location.code == line.location,
            Location.warehouse_id == warehouse.id
        ).first()
        if not location:
            raise HTTPException(status_code=404, detail=f"Location not found: {line.location}")

        db.add(ReceivingLine(
            receiving_id=header.id,
            item_id=item.id,
            location_id=location.id,
            quantity=line.quantity,
            batch_no=line.batch_no,
            manufacturing_date=line.manufacturing_date,
            expiry_date=line.expiry_date,
            shelf_expiry_date=line.shelf_expiry_date,
            status=line.status
        ))

    db.commit()
    db.refresh(header)

    return {"status": "success", "grn_id": header.id}


# ─────────────────────────────────────────────────────────────────────────────
# NEW: Add a line item to an existing header
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/lines/add")
def add_line_to_header(payload: dict, db: Session = Depends(get_db)):
    """
    Add a new line item to an existing receiving header.
    Payload: { header_id, item_code, location, quantity, status, batch_no?,
               manufacturing_date?, expiry_date?, shelf_expiry_date? }
    """
    header_id = payload.get("header_id")
    if not header_id:
        raise HTTPException(status_code=400, detail="header_id is required.")

    header = db.query(ReceivingHeader).filter(ReceivingHeader.id == header_id).first()
    if not header:
        raise HTTPException(status_code=404, detail="Header not found.")

    item_code = (payload.get("item_code") or "").strip()
    if not item_code:
        raise HTTPException(status_code=400, detail="item_code is required.")

    location_code = (payload.get("location") or "").strip()
    if not location_code:
        raise HTTPException(status_code=400, detail="location is required.")

    quantity = payload.get("quantity")
    if not quantity or int(quantity) <= 0:
        raise HTTPException(status_code=400, detail="quantity must be > 0.")

    status = (payload.get("status") or "").strip().lower()
    if status not in ("ok", "damaged"):
        raise HTTPException(status_code=400, detail="status must be 'ok' or 'damaged'.")

    # Ensure item exists (create if missing)
    item = db.query(Item).filter(Item.code == item_code).first()
    if not item:
        item = Item(code=item_code, name=item_code)
        db.add(item)
        db.flush()

    # Ensure location exists for the header's warehouse
    location = db.query(Location).filter(
        Location.code == location_code,
        Location.warehouse_id == header.warehouse_id
    ).first()
    if not location:
        raise HTTPException(
            status_code=404,
            detail=f"Location '{location_code}' not found in warehouse."
        )

    from datetime import date as date_type

    def parse_date(val):
        if not val:
            return None
        if isinstance(val, str):
            try:
                return date_type.fromisoformat(val)
            except ValueError:
                return None
        return val

    new_line = ReceivingLine(
        receiving_id=header.id,
        item_id=item.id,
        location_id=location.id,
        quantity=int(quantity),
        status=status,
        batch_no=(payload.get("batch_no") or "").strip() or None,
        manufacturing_date=parse_date(payload.get("manufacturing_date")),
        expiry_date=parse_date(payload.get("expiry_date")),
        shelf_expiry_date=parse_date(payload.get("shelf_expiry_date")),
    )
    db.add(new_line)
    db.commit()
    db.refresh(new_line)

    return {
        "status": "success",
        "line_id": new_line.id,
        "header_id": header.id,
    }


@router.patch("/lines/{line_id}")
def update_line(line_id: int, payload: ReceivingLineUpdatePayload, db: Session = Depends(get_db)):
    """
    Update an existing receiving line. Use getattr to safely check optional fields
    so we don't raise AttributeError when the Pydantic model doesn't include a field.
    """
    line = db.query(ReceivingLine).filter(ReceivingLine.id == line_id).first()
    if not line:
        raise HTTPException(status_code=404, detail="Line not found")

    # Optional: update item if item_code is supplied
    item_code = getattr(payload, "item_code", None)
    if item_code is not None:
        item_code = item_code.strip()
        if item_code:
            item = db.query(Item).filter(Item.code == item_code).first()
            if not item:
                item = Item(code=item_code, name=item_code)
                db.add(item)
                db.flush()
            line.item_id = item.id

    # Optional: update location (ensure it exists for the header's warehouse)
    location_code = getattr(payload, "location", None)
    if location_code is not None:
        header = db.query(ReceivingHeader).filter(ReceivingHeader.id == line.receiving_id).first()
        if not header:
            raise HTTPException(status_code=404, detail="Parent header not found for this line")
        location = db.query(Location).filter(
            Location.code == location_code,
            Location.warehouse_id == header.warehouse_id
        ).first()
        if not location:
            raise HTTPException(status_code=404, detail=f"Location not found: {location_code}")
        line.location_id = location.id

    # Other optional fields
    if getattr(payload, "batch_no", None) is not None:
        line.batch_no = payload.batch_no
    if getattr(payload, "manufacturing_date", None) is not None:
        line.manufacturing_date = payload.manufacturing_date
    if getattr(payload, "expiry_date", None) is not None:
        line.expiry_date = payload.expiry_date
    if getattr(payload, "shelf_expiry_date", None) is not None:
        line.shelf_expiry_date = payload.shelf_expiry_date
    if getattr(payload, "quantity", None) is not None:
        line.quantity = payload.quantity
    if getattr(payload, "status", None) is not None:
        line.status = payload.status

    db.commit()
    db.refresh(line)
    return {"status": "success", "line_id": line_id}

@router.patch("/headers/{header_id}")
def update_header(header_id: int, payload: ReceivingHeaderUpdatePayload, db: Session = Depends(get_db)):
    header = db.query(ReceivingHeader).filter(ReceivingHeader.id == header_id).first()
    if not header:
        raise HTTPException(status_code=404, detail="Header not found")

    if getattr(payload, "customer", None) is not None:
        header.customer = payload.customer
    if getattr(payload, "receiving_date", None) is not None:
        header.receiving_date = payload.receiving_date
    if getattr(payload, "reference_no", None) is not None:
        header.reference_no = payload.reference_no
    if getattr(payload, "warehouse", None) is not None:
        warehouse = db.query(Warehouse).filter(Warehouse.code == payload.warehouse).first()
        if not warehouse:
            raise HTTPException(status_code=404, detail="Warehouse not found")
        header.warehouse_id = warehouse.id

    db.commit()
    db.refresh(header)
    return {"status": "success", "header_id": header_id}

@router.delete("/lines/{line_id}")
def delete_line(line_id: int, db: Session = Depends(get_db)):
    """
    Delete a receiving line. If it was the last line for the header, also delete the header.
    """
    line = db.query(ReceivingLine).filter(ReceivingLine.id == line_id).first()
    if not line:
        raise HTTPException(status_code=404, detail="Line not found")

    receiving_id = line.receiving_id

    # Delete the line
    db.delete(line)
    db.commit()

    # If no remaining lines for the header, remove the header too
    remaining = db.query(ReceivingLine).filter(ReceivingLine.receiving_id == receiving_id).count()
    if remaining == 0:
        header = db.query(ReceivingHeader).filter(ReceivingHeader.id == receiving_id).first()
        if header:
            db.delete(header)
            db.commit()

    return {"status": "deleted", "deleted_line": line_id, "receiving_id": receiving_id}

@router.delete("/headers/by-ref/{reference_no}")
def delete_by_reference(reference_no: str, db: Session = Depends(get_db)):
    """
    Delete all headers matching reference_no (case-insensitive, whitespace-trimmed).
    PO-01 will match po-01 or "PO-01 " with trailing spaces in the database.
    """
    from sqlalchemy import func as sql_func
    ref_clean = reference_no.strip()

    headers = db.query(ReceivingHeader).filter(
        sql_func.lower(sql_func.trim(ReceivingHeader.reference_no)) == ref_clean.lower()
    ).all()

    if not headers:
        raise HTTPException(
            status_code=404,
            detail=f"No record found with reference '{reference_no}'. Check the reference number and try again."
        )

    total_lines = 0
    for header in headers:
        total_lines += db.query(ReceivingLine).filter(
            ReceivingLine.receiving_id == header.id
        ).delete(synchronize_session=False)
        db.delete(header)

    db.commit()
    return {
        "status": "deleted",
        "reference_no": reference_no,
        "deleted_headers": len(headers),
        "deleted_lines": total_lines
    }