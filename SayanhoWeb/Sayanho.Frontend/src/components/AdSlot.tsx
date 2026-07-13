interface AdSlotProps {
    slotId: string;
}

export const AdSlot = ({ slotId }: AdSlotProps) => (
    <aside className="ad-slot" aria-label="Sponsored content">
        <span className="ad-slot-label">Advertisement</span>
        <div className="ad-slot-frame" data-ad-slot={slotId}>
            Sponsored placement
        </div>
    </aside>
);
